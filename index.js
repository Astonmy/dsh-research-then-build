import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { preflight, spawnChild } from './lib/agents.js'
import { Journal } from './lib/journal.js'
import { deepModeBrief } from './lib/prompts.js'
import { renderStatus } from './lib/report.js'
import { createState, isActive } from './lib/state.js'
import { DeepStateStore } from './lib/store.js'
import { createDeepTools } from './lib/tools.js'

export const name = 'deep-loop'
export const inject = ['commands', 'subagents', 'tools', 'sessions']

const SOURCE = { kind: 'deep-loop' }
const DEFAULT_MAX_ROUNDS = 3
const MAX_ROUNDS_CEILING = 6
/** 一轮结束时最多提醒几次，防止和"模型不配合"死循环。 */
const MAX_NUDGES = 2

function normalizeMaxRounds(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_ROUNDS
  return Math.min(Math.floor(parsed), MAX_ROUNDS_CEILING)
}

export function apply(ctx, config = {}) {
  const maxRounds = normalizeMaxRounds(config.maxRounds)
  const probe = config.probe === 'every' ? 'every' : 'last'
  const journal = new Journal(config.reportDirectory)
  const store = new DeepStateStore(journal)

  /** agentId -> 该会话专用工具的注销函数。 */
  const scoped = new Map()
  let globalDisposers = null

  const makeDefs = () =>
    createDeepTools({
      ctx,
      store,
      spawn: spawnChild,
      probe,
      onClose: (agentId) => closeScoped(agentId),
    })

  function closeScoped(agentId) {
    const disposers = scoped.get(agentId)
    if (!disposers) return
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 已注销 */
      }
    }
    scoped.delete(agentId)
  }

  /**
   * 只在当前会话注册三个工具：不进深度模式的会话完全看不到它们，省掉每次请求的常驻描述。
   * 注册后立刻验证可见性；任何一环不成立就回退到全局注册（能力优先于省 token）。
   */
  function openScoped(agent) {
    const definitions = makeDefs()
    const disposers = []
    try {
      for (const definition of definitions) disposers.push(agent.ctx.tools.register(definition))
      const visible = definitions.every((definition) => {
        try {
          return agent.ctx.tools.get(definition.name, agent) !== undefined
        } catch {
          return false
        }
      })
      if (!visible) throw new Error('scoped tool registration not visible')
      return disposers
    } catch (error) {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 已注销 */
        }
      }
      ctx.logger?.warn?.(
        `deep-loop: 会话级工具注册不可用，回退全局注册（${error instanceof Error ? error.message : String(error)}）`,
      )
      return null
    }
  }

  function ensureGlobal() {
    if (globalDisposers) return
    globalDisposers = makeDefs().map((definition) => ctx.tools.register(definition))
  }

  ctx.effect(() => {
    void store.warm().catch((error) => {
      ctx.logger?.warn?.(`deep-loop: warm failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return () => {
      for (const agentId of [...scoped.keys()]) closeScoped(agentId)
      if (globalDisposers) {
        for (const dispose of globalDisposers) {
          try {
            dispose()
          } catch {
            /* 已注销 */
          }
        }
        globalDisposers = null
      }
    }
  })

  /**
   * 收尾拦截：`agent/turn-stopping` 在回合边界被串行等待，监听器可以把工作塞回 inbox，
   * 让机器再读一次、继续这一步。用它把"没交付就收尾"变成一次可见的纠正轮。
   */
  ctx.on('agent/turn-stopping', ({ agent }) => {
    try {
      const state = store.peek(agent.id)
      if (!isActive(state)) return
      if ((state.nudges ?? 0) >= MAX_NUDGES) return
      state.nudges = (state.nudges ?? 0) + 1
      void store.set(agent.id, state)
      agent.followup(
        createUserMessage({
          content: [
            {
              type: 'text',
              text: `你还在深度模式里，但这一轮结束了却没有交付。继续推进（缺台账就调研、缺检查就 deep_critique、或者直接把缺陷修掉），完成后调用 deep_finish 交付。不要跳过门禁直接给结论。（第 ${state.nudges}/${MAX_NUDGES} 次提醒）`,
            },
          ],
          source: SOURCE,
        }),
      )
    } catch (error) {
      ctx.logger?.warn?.(`deep-loop: turn-stopping nudge failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  ctx.commands.register({
    name: 'deep-status',
    description: '查看当前深度模式状态',
    async handler({ agent }) {
      const live = await store.get(agent.id)
      if (isActive(live)) return { kind: 'success', text: renderStatus(live) }
      const record = await journal.read(agent.id).catch(() => null)
      if (record && record.version === 2) return { kind: 'success', text: renderStatus(record) }
      if (record) return { kind: 'success', text: `发现一份旧格式（v1）的循环记录：${record.task ?? ''}。它属于 \`/deep\` 阻塞命令时代，不再更新。` }
      return { kind: 'success', text: '当前不在深度模式。输入 /deep <任务> 进入。' }
    },
  })

  ctx.commands.register({
    name: 'deep-exit',
    description: '退出深度模式（不交付）',
    async handler({ agent }) {
      const state = await store.get(agent.id)
      if (!isActive(state)) return { kind: 'success', text: '当前不在深度模式。' }
      state.state = 'closed'
      state.finishedAt = new Date().toISOString()
      state.result = { summary: '（用户主动退出，未交付）', exited: true }
      await store.set(agent.id, state)
      store.drop(agent.id)
      closeScoped(agent.id)
      return { kind: 'success', text: '已退出深度模式。' }
    },
  })

  ctx.commands.register({
    name: 'deep',
    description: '进入深度模式：先分析问题，需要时派子 Agent 调研，自己实现，再由独立 Agent 挑刺',
    input: { hint: '输入任务，例如：给这个项目加上用户登录' },
    async handler(invocation) {
      const { agent, rawInput } = invocation
      const task = String(rawInput ?? '').trim()
      if (!task) return { kind: 'error', text: '请给出任务描述，例如：/deep 给这个项目加上用户登录' }

      const existing = await store.get(agent.id)
      if (isActive(existing)) {
        return { kind: 'error', text: '已经在这个任务的深度模式里了。用 /deep-status 看进度，/deep-exit 退出后再说新任务。' }
      }
      const blocker = preflight(ctx, agent)
      if (blocker) return { kind: 'error', text: blocker }

      const state = createState({ task, maxRounds })
      state.id = randomUUID()
      await store.set(agent.id, state)

      // 工具只对本会话可见；不可用时自动回退全局注册。
      const disposers = openScoped(agent)
      if (disposers) scoped.set(agent.id, disposers)
      else ensureGlobal()

      try {
        agent.followup(
          createUserMessage({
            content: [{ type: 'text', text: deepModeBrief({ task, maxRounds }) }],
            source: SOURCE,
          }),
        )
      } catch {
        closeScoped(agent.id)
        return { kind: 'error', text: '无法唤醒当前会话（可能已销毁）。' }
      }

      return {
        kind: 'success',
        text: `已进入深度模式（最多 ${maxRounds} 轮独立检查）。接下来我会先把问题分析清楚，需要外部事实时再派子 Agent。`,
      }
    },
  })
}
