import { defineTool } from '@deepseek-ai/dsh-tools'
import { fingerprint } from './fingerprint.js'
import {
  CRITIC_RETRY_NUDGE,
  confidenceBrief,
  criticBrief,
  criticPersona,
  omissionBrief,
  researchBrief,
  researchPersona,
  reviewerPersona,
} from './prompts.js'
import { canFinish, dirtyRounds, isActive, recordCritique, recordResearch, shouldProbe } from './state.js'
import {
  formatCritique,
  formatResidue,
  parseConfidence,
  parseCritique,
  parseOmissions,
  renderFinalReport,
  validateLedger,
} from './report.js'

const RESEARCH_DENY = ['write', 'edit', 'pwsh', 'bash', 'todo_write', 'present']
const CRITIC_DENY = ['write', 'edit', 'todo_write', 'present']

async function requireState(store, exec) {
  const agent = exec.agent
  if (!agent) throw new Error('这个工具需要由一个 Agent 会话调用。')
  const state = await store.get(agent.id)
  if (!isActive(state)) {
    throw new Error('当前不在先调研后建模式。让用户先输入 /research <任务> 进入。')
  }
  return { agent, state }
}

function findingsText(critique) {
  const rows = [...critique.severe, ...critique.minor]
  if (!rows.length) return '（上一轮没有发现问题）'
  return rows.map((item, i) => `${i + 1}. ${item.title}${item.where ? `（${item.where}）` : ''}`).join('\n')
}

/**
 * 三个模型侧工具：调研、独立检查、交付。
 * 主 Agent 自己分析、自己实现；这三件事才派子 Agent，且按需调用。
 */
export function createResearchTools({ ctx, store, spawn, probe = 'last', onClose }) {
  /** 同一会话同时只允许一次独立检查，避免轮次记账竞态。 */
  const busy = new Set()

  const research = defineTool({
    name: 'research_survey',
    description:
      '先调研后建模式下调研一个能力点：检索现成的库/服务/SDK/模板仓库，产出一份「采购台账」，结论是「采用现成方案」或「自研（必须落在三种例外之一）」。调研 Agent 只读、不改代码。涉及「有没有现成方案、某库是否支持某能力、许可证是什么」时用它，不要凭记忆回答。',
    parameters: {
      question: {
        type: 'string',
        required: true,
        description: '要调研的能力点或问题，例如「用户登录该用哪个现成方案」。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          ledger: { type: 'string', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.note ? `${value.note}\n\n${value.ledger}` : value.ledger }],
    },
    presentCall: (args) => ({ card: 'generic', title: '调研选型', kind: 'other', rawInput: args.question }),
    async execute(args, exec) {
      const { agent, state } = await requireState(store, exec)
      exec.signal?.throwIfAborted()
      const text = (
        await spawn(ctx, agent, {
          label: '选型调研',
          persona: researchPersona(),
          prompt: researchBrief({ task: state.task, question: args.question }),
          deny: RESEARCH_DENY,
          signal: exec.signal,
        })
      ).trim()

      const check = validateLedger(text)
      if (!check.ok) {
        return {
          ok: false,
          ledger: text,
          note: `调研输出还缺「${check.missing.join('、')}」。请再调一次 research_survey 并明确要求按台账格式输出，或补上结论。`,
        }
      }
      recordResearch(state, text)
      await store.set(agent.id, state)
      return { ok: true, ledger: text }
    },
  })

  const critique = defineTool({
    name: 'research_challenge',
    description:
      '派独立上下文的 Agent 检查当前实现，并追问两个不同的问题：还有哪些地方没被覆盖、以及哪些判断是有把握的（两者的依据都要能落到文件或命令）。检查者自己跑 git status / git diff、读代码，按「绕开台账 / 假证据 / 功能遗漏 / 未验证 / 过度设计」五个维度挑刺。它看不到你的推理过程。实现到一个可验收的段落后调用它。',
    parameters: {
      focus: {
        type: 'string',
        description: '本轮特别想让它盯的地方（可选），例如「重点看会话令牌能否被伪造」。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          converged: { type: 'boolean', required: true },
          round: { type: 'integer', required: true },
          severe: { type: 'integer', required: true },
          minor: { type: 'integer', required: true },
          omissions: { type: 'integer', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    presentCall: (args) => ({ card: 'generic', title: '独立检查 + 遗漏追问', kind: 'other', rawInput: args.focus ?? '' }),
    async execute(args, exec) {
      const { agent, state } = await requireState(store, exec)
      const last = state.rounds.length ? state.rounds[state.rounds.length - 1] : null
      if (last && !last.converged && dirtyRounds(state) >= state.maxRounds) {
        return {
          ok: true,
          converged: false,
          round: state.rounds.length,
          severe: last.severe.length,
          minor: last.minor.length,
          omissions: last.omissions?.length ?? 0,
          report: `严重问题已经用满 ${state.maxRounds} 轮，不再加派检查。现在用 research_finish 交付，并在交付摘要里写清还剩哪些问题。`,
        }
      }
      if (busy.has(agent.id)) {
        throw new Error('上一次独立检查还在运行，等它结束再调用 research_challenge。')
      }
      busy.add(agent.id)
      try {
        exec.signal?.throwIfAborted()
        const round = state.rounds.length + 1
        const brief = criticBrief({ task: state.task, ledger: state.ledger, focus: args.focus, round })

        // 第 1 问：挑刺。
        let raw = await spawn(ctx, agent, {
          label: `独立检查 第${round}轮`,
          persona: criticPersona(),
          prompt: brief,
          deny: CRITIC_DENY,
          signal: exec.signal,
        })
        let parsed = parseCritique(raw)
        if (!parsed) {
          raw = await spawn(ctx, agent, {
            label: `独立检查 第${round}轮（重试）`,
            persona: criticPersona(),
            prompt: `${brief}${CRITIC_RETRY_NUDGE}`,
            deny: CRITIC_DENY,
            signal: exec.signal,
          })
          parsed = parseCritique(raw)
        }
        if (!parsed) {
          return {
            ok: false,
            converged: false,
            round,
            severe: 0,
            minor: 0,
            omissions: 0,
            report: `检查 Agent 没有返回可解析的 JSON，本轮不计入轮次。原始输出前 400 字：${raw.slice(0, 400)}`,
          }
        }

        // 第 2、3 问：分开问、并行跑。默认只在收敛或最后一轮跑（probe: 'every' 可恢复每轮都问）。
        const runProbes = shouldProbe({ critique: parsed, round, maxRounds: state.maxRounds, probe })
        let omissions = null
        let confident = null
        if (runProbes) {
          const [omissionText, confidenceText] = await Promise.all([
            spawn(ctx, agent, {
              label: `遗漏追问 第${round}轮`,
              persona: reviewerPersona(),
              prompt: omissionBrief({ task: state.task, findings: findingsText(parsed) }),
              deny: CRITIC_DENY,
              signal: exec.signal,
            }).catch(() => ''),
            spawn(ctx, agent, {
              label: `把握盘点 第${round}轮`,
              persona: reviewerPersona(),
              prompt: confidenceBrief({ task: state.task, ledger: state.ledger }),
              deny: CRITIC_DENY,
              signal: exec.signal,
            }).catch(() => ''),
          ])
          omissions = parseOmissions(omissionText)
          confident = parseConfidence(confidenceText)
        }

        // 指纹在全部子 Agent 跑完之后取：它们若在工作目录留下产物，不会被误判成"检查后又被改过"。
        const checkedAt = await fingerprint(agent.session?.header?.cwd).catch(() => '')

        recordCritique(state, parsed, checkedAt)
        const stored = state.rounds[state.rounds.length - 1]
        stored.probed = runProbes
        stored.omissions = omissions ?? []
        stored.omissionsOk = omissions !== null
        stored.confident = confident ?? []
        await store.set(agent.id, state)

        const header = parsed.converged
          ? `第 ${round} 轮：没有发现会改变结论的问题。可以 research_finish 了。`
          : `第 ${round} 轮：${parsed.severe.length} 条严重问题，修完再调 research_challenge。`
        const residue = formatResidue(stored)
        return {
          ok: true,
          converged: parsed.converged,
          round,
          severe: parsed.severe.length,
          minor: parsed.minor.length,
          omissions: stored.omissions.length,
          report: [header, '', formatCritique(parsed), residue.length ? `\n${residue.join('\n')}` : '']
            .filter(Boolean)
            .join('\n'),
        }
      } finally {
        busy.delete(agent.id)
      }
    },
  })

  const finish = defineTool({
    name: 'research_finish',
    description:
      '结束先调研后建模式并交付。只有在已有采购台账、且最近一轮独立检查没有严重问题时才会放行；否则返回还差什么。',
    parameters: {
      summary: {
        type: 'string',
        required: true,
        description: '交付摘要：改了什么、怎么验证的、还剩什么没做。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    presentCall: () => ({ card: 'generic', title: '交付', kind: 'other' }),
    async execute(args, exec) {
      const { agent, state } = await requireState(store, exec)
      const current = await fingerprint(agent.session?.header?.cwd).catch(() => '')
      const verdict = canFinish(state, current)
      if (!verdict.ok) return { ok: false, report: `还不能交付：${verdict.reason}` }

      state.state = 'closed'
      state.finishedAt = new Date().toISOString()
      state.result = { summary: args.summary }
      await store.set(agent.id, state)
      store.drop(agent.id)
      // 交付完就把本会话的工具撤掉，别让它们继续占着上下文。延到本次调用之后再注销。
      queueMicrotask(() => {
        try {
          onClose?.(agent.id)
        } catch {
          /* 注销失败不影响交付 */
        }
      })
      return { ok: true, report: renderFinalReport(state, args.summary) }
    },
  })

  return [research, critique, finish]
}
