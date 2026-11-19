import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'

const LANGUAGE = '全部输出使用简体中文。'

/**
 * 进入先看后建模式前的硬性条件检查。返回 null 表示可以跑，否则返回一句可操作的原因。
 */
export function preflight(ctx, agent) {
  let provider
  try {
    provider = ctx.subagents?.getProvider?.('spawn')
  } catch {
    provider = undefined
  }
  if (!provider) return '没有可用的 spawn 子 Agent provider，先看后建模式无法启动。'
  if (provider.inheritsParentContext) {
    return '当前的 spawn provider 会继承父上下文，挑刺就不是独立的了。请换用原生 spawn provider。'
  }
  if (!agent?.session?.header?.cwd) return '当前会话没有有效的工作目录（cwd），先看后建模式无法启动。'
  return null
}

function abortError(signal) {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  return Object.assign(new Error('操作已中止。'), { name: 'AbortError' })
}

/** 等待 activation 结果；abort 时立刻 reject 并 fire-and-forget dispose，避免与未协作的 LLM stream 死锁。 */
function awaitActivationResult(activation, signal) {
  if (signal?.aborted) {
    void activation.dispose()
    return Promise.reject(abortError(signal))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void activation.dispose()
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    activation.result.then(
      (result) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(result)
      },
      (error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function outputText(result) {
  if (!result) throw new Error('子 Agent 没有返回结果。')
  if (result.stopReason && result.stopReason !== 'completed') {
    throw new Error(`子 Agent 未完成：${result.stopReason}${result.diagnostic ? ` ${result.diagnostic}` : ''}`)
  }
  const blocks = Array.isArray(result.output) ? result.output : []
  const text = blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
  if (!text.trim()) throw new Error('子 Agent 没有返回文本。')
  return text
}

/**
 * 以独立上下文启动一个原生子 Agent，只给它这一段 persona 和这一条任务。
 * 三种角色复用同一入口，靠 persona + deny 列表区分。
 */
export async function spawnChild(ctx, parent, { label, persona, prompt, deny = [], model, signal }) {
  const provider = ctx.subagents.getProvider('spawn')
  if (!provider || provider.inheritsParentContext) {
    throw new Error('缺少独立上下文的原生 spawn provider，无法运行先看后建流程。')
  }
  const subagents = ctx.subagents
  const childId = SessionId(randomUUID())
  const personaText = `${persona}\n\n${LANGUAGE}`
  const denyList = deny.filter((toolName) => {
    try {
      return ctx.tools.get(toolName, parent) !== undefined
    } catch {
      return false
    }
  })

  let handle
  let result
  try {
    if (typeof subagents.startActivation === 'function') {
      const stop = ctx.on('agent/created', ({ agent }) => {
        if (agent.id !== childId) return undefined
        agent.ctx.systemPrompt.section({
          name: PERSONA_PREFIX_SECTION,
          order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
          text: personaText,
        })
        if (denyList.length) agent.ctx.tools.restrict({ deny: denyList })
        return undefined
      })
      try {
        // 0.2.1-rc.1 起是扁平 spec；更早的版本要包一层 request。
        const flat = typeof subagents.rootOf === 'function'
        const common = {
          provider: 'spawn',
          label,
          childId,
          signal,
          delivery: 'caller',
        }
        const body = {
          parent,
          prompt: [{ type: 'text', text: prompt }],
          ...(model ? { agentOptions: { model } } : {}),
        }
        handle = await subagents.startActivation(flat ? { ...common, ...body } : { ...common, request: body })
      } finally {
        stop()
      }
      result = await awaitActivationResult(handle, signal)
    } else {
      const capabilities = provider.capabilities
      if (!capabilities || !capabilities.persona || !capabilities.toolFilter || typeof subagents.start !== 'function') {
        throw new Error('缺少独立上下文的原生 spawn provider，无法运行先看后建流程。')
      }
      handle = await subagents.start('spawn', {
        parent,
        label,
        signal,
        persona: personaText,
        ...(model ? { agentOptions: { model } } : {}),
        toolFilter: { deny: denyList },
        prompt: [{ type: 'text', text: prompt }],
      })
      result = await handle.result
    }
  } finally {
    if (handle) {
      try {
        if (signal?.aborted) {
          await Promise.race([handle.dispose(), new Promise((resolve) => setTimeout(resolve, 2000))])
        } else {
          await handle.dispose()
        }
      } catch {
        /* 清理失败不覆盖主结果 */
      }
    }
  }
  return outputText(result)
}
