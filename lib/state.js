/**
 * 先调研后建模式的状态。纯数据 + 纯函数，便于单测；持久化由调用方负责。
 */

export function createState({ task, maxRounds }) {
  return {
    version: 2,
    task,
    maxRounds,
    enteredAt: new Date().toISOString(),
    ledger: '',
    rounds: [],
    nudges: 0,
    state: 'active',
    finishedAt: null,
    result: null,
  }
}

export function recordResearch(state, text) {
  const chunk = String(text ?? '').trim()
  if (!chunk) return state
  // 多次调研累积，不覆盖：多能力点任务不该只剩最后一份台账。
  state.ledger = state.ledger ? `${state.ledger}\n\n${chunk}` : chunk
  return state
}

export function recordCritique(state, critique, fingerprint = '') {
  state.rounds.push({
    round: state.rounds.length + 1,
    converged: critique.converged,
    severe: critique.severe,
    minor: critique.minor,
    fingerprint,
    at: new Date().toISOString(),
  })
  // 每轮重置收尾提醒预算：新的一轮应该有新的提醒额度。
  state.nudges = 0
  return state
}

export function lastCritique(state) {
  return state.rounds.length ? state.rounds[state.rounds.length - 1] : null
}

/** 产出了严重问题的轮次数。轮次上限只约束这个，不约束"改完再看一眼"。 */
export function dirtyRounds(state) {
  return state.rounds.filter((round) => !round.converged).length
}

/**
 * 是否允许交付。「调研在前、挑刺在后、结论不过期」三条规则的唯一执行点。
 * currentFingerprint 用来发现"检查之后代码又被改了"，那样检查结论就是过期的。
 */
export function canFinish(state, currentFingerprint = '') {
  if (state.state !== 'active') return { ok: false, reason: '当前不在先调研后建模式。' }
  if (!state.ledger) {
    return {
      ok: false,
      reason: '还没有采购台账：先调用 research_survey 把「用现成方案还是自研」定下来，否则无法证明没有重复造轮子。',
    }
  }
  const last = lastCritique(state)
  if (!last) {
    return { ok: false, reason: '还没有经过独立检查：实现后调用 research_challenge。' }
  }
  if (!last.converged) {
    // 严重问题轮次没用尽 → 先修；用尽了 → 允许带问题交付，但报告会列出来。
    if (dirtyRounds(state) < state.maxRounds) {
      return {
        ok: false,
        reason: `第 ${last.round} 轮批评仍有 ${last.severe.length} 条严重问题，且还有改的机会。先修掉它们，然后重新调用 research_challenge。`,
      }
    }
    return { ok: true }
  }
  if (last.fingerprint && currentFingerprint && last.fingerprint !== currentFingerprint) {
    return {
      ok: false,
      reason: '独立检查之后代码又被改过了，那份检查结论已经过期。再调用一次 research_challenge（清理性的复检不受轮次上限限制）。',
    }
  }
  return { ok: true }
}

/** 该 Agent 是否处于先调研后建模式。 */
export function isActive(state) {
  return Boolean(state) && state.state === 'active'
}

/**
 * 要不要跑「遗漏追问 + 把握盘点」。
 * 这两问是收尾问题：中间轮的答案下一轮就作废。默认只在收敛或最后一轮跑，
 * 省掉每轮两次子 Agent；probe: 'every' 可以恢复每轮都问。
 */
export function shouldProbe({ critique, round, maxRounds, probe = 'last' }) {
  if (probe === 'every') return true
  return Boolean(critique?.converged) || round >= maxRounds
}
