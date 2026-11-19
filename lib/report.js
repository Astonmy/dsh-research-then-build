const LEDGER_LIMIT = 4000
const SUMMARY_LIMIT = 1200

function clip(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n…（已截断，原文 ${value.length} 字）`
}

function oneLine(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/**
 * 采购台账的最低形状检查：没有台账就没法执行「不许自研」这条规则，
 * 所以宁可中止，也不让循环带着空台账跑下去。
 */
export function validateLedger(text) {
  const value = String(text ?? '')
  const missing = []
  if (!/能力点/.test(value)) missing.push('能力点')
  if (!/结论\s*[:：]/.test(value)) missing.push('结论')
  return { ok: missing.length === 0, missing }
}

/** 从挑刺 Agent 的输出里抠 JSON；容忍 ```json 围栏和前后废话。 */
export function parseCritique(text) {
  const raw = String(text ?? '')
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  const candidates = [fenced?.[1], start >= 0 && end > start ? raw.slice(start, end + 1) : '', raw]
  for (const candidate of candidates) {
    if (!candidate || !candidate.trim()) continue
    try {
      const parsed = JSON.parse(candidate.trim())
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      // 形状必须严格：severe 必须是数组，converged 必须是布尔，缺一不可。
      // 否则一条真有问题的检查会被读成"零 severe、已收敛"，那就是假通过。
      if (!Array.isArray(parsed.severe) || typeof parsed.converged !== 'boolean') continue
      const severe = normalizeList(parsed.severe)
      if (parsed.severe.length > 0 && severe.length === 0) continue
      const minor = normalizeList(parsed.minor)
      return { converged: severe.length === 0 && parsed.converged, severe, minor }
    } catch {
      /* 试下一个候选 */
    }
  }
  return null
}

function normalizeList(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (!item) return null
      if (typeof item === 'string') return { title: item, where: '', why: '' }
      if (typeof item !== 'object') return null
      return {
        title: String(item.title ?? item.name ?? '').trim(),
        where: String(item.where ?? item.location ?? '').trim(),
        why: String(item.why ?? item.reason ?? '').trim(),
      }
    })
    .filter((item) => item && (item.title || item.why))
}

/** 从任意文本里抠出第一个可用 JSON 对象；形状校验交给调用方。 */
export function parseJsonObject(text) {
  const raw = String(text ?? '')
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  const candidates = [fenced?.[1], start >= 0 && end > start ? raw.slice(start, end + 1) : '', raw]
  for (const candidate of candidates) {
    if (!candidate || !candidate.trim()) continue
    try {
      const parsed = JSON.parse(candidate.trim())
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* 试下一个候选 */
    }
  }
  return null
}

function normalizeRows(value, fields) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const row = {}
      for (const [key, aliases] of Object.entries(fields)) {
        for (const alias of [key, ...aliases]) {
          const raw = item[alias]
          if (typeof raw === 'string' && raw.trim()) {
            row[key] = raw.trim()
            break
          }
        }
      }
      return Object.keys(row).length ? row : null
    })
    .filter(Boolean)
}

/** 追问一的输出：还有哪些没被覆盖。形状不对返回 null，由上层决定是否只是提示。 */
export function parseOmissions(text) {
  const parsed = parseJsonObject(text)
  if (!parsed || !Array.isArray(parsed.omissions)) return null
  return normalizeRows(parsed.omissions, { title: ['name', 'item'], where: ['location'], why: ['reason', 'risk'] })
}

/** 追问二的输出：哪些判断有把握。 */
export function parseConfidence(text) {
  const parsed = parseJsonObject(text)
  if (!parsed || !Array.isArray(parsed.confident)) return null
  return normalizeRows(parsed.confident, { what: ['claim', 'title'], basis: ['evidence', 'why'] })
}

export function formatCritique(critique) {
  if (!critique) return ''
  const lines = []
  if (critique.severe.length) {
    lines.push(
      '## 必须解决的严重问题',
      ...critique.severe.map(
        (item, i) => `${i + 1}. ${item.title}\n   位置：${item.where || '未指明'}\n   原因：${item.why || '未说明'}`,
      ),
    )
  }
  if (critique.minor.length) {
    lines.push(
      '',
      '## 改进建议（不阻塞交付）',
      ...critique.minor.map((item) => `- ${item.title}${item.where ? `（${item.where}）` : ''}`),
    )
  }
  return lines.join('\n')
}

export function formatResidue(round) {
  if (!round) return []
  const lines = []
  if (round.probed === false) {
    return ['### 没被覆盖到的地方', '', '（本轮未追问：只在收敛或最后一轮统一问，省下每轮两次子 Agent）']
  }
  if (round.omissionsOk === false) {
    lines.push('### 没被覆盖到的地方', '', '（追问的 Agent 没有返回可解析的 JSON，这次没有拿到遗漏清单）')
  } else if (round.omissions?.length) {
    lines.push('### 没被覆盖到的地方', '', ...round.omissions.map((item) => `- ${item.title}${item.where ? `（${item.where}）` : ''}${item.why ? `：${item.why}` : ''}`))
  } else {
    lines.push('### 没被覆盖到的地方', '', '（追问后没有发现未覆盖的部分）')
  }
  if (round.confident?.length) {
    lines.push('', '### 有把握的部分', '', ...round.confident.map((item) => `- ${item.what}${item.basis ? ` —— 依据：${item.basis}` : ''}`))
  }
  return lines
}

export function renderFinalReport(state, summary) {
  const last = state.rounds.length ? state.rounds[state.rounds.length - 1] : null
  const lines = [
    '## 先看后建模式 · 已交付',
    '',
    `- 任务：${oneLine(state.task, 200)}`,
    `- 独立检查：${state.rounds.length}/${state.maxRounds} 轮`,
    `- 采购台账：${state.ledger ? '有' : '无'}`,
  ]

  if (summary) lines.push('', '### 交付摘要', '', clip(summary, SUMMARY_LIMIT))
  lines.push('', '### 技术选型台账', '', clip(state.ledger || '（无）', LEDGER_LIMIT))

  if (state.rounds.length) {
    lines.push('', '### 独立检查记录', '')
    for (const round of state.rounds) {
      lines.push(`- 第 ${round.round} 轮：严重 ${round.severe.length} / 建议 ${round.minor.length}`)
    }
  }

  if (last && last.severe.length) {
    lines.push('', '### 仍未解决的严重问题（已到轮次上限）', '', formatCritique({ severe: last.severe, minor: [] }))
  } else if (last && last.minor.length) {
    lines.push('', '### 剩余建议', '', formatCritique({ severe: [], minor: last.minor }))
  }
  if (last) lines.push('', ...formatResidue(last))
  return lines.join('\n')
}

export function renderStatus(state) {
  if (!state) return '当前不在先看后建模式，也没有历史记录。'
  if (state.result?.exited) return '## 先看后建模式 · 已退出（未交付）'
  if (state.state === 'active') {
    const last = state.rounds.length ? state.rounds[state.rounds.length - 1] : null
    return [
      '## 先看后建模式 · 进行中',
      '',
      `- 任务：${oneLine(state.task, 200)}`,
      `- 采购台账：${state.ledger ? '已有' : '还没有（look_survey）'}`,
      `- 独立检查：${state.rounds.length}/${state.maxRounds} 轮${last ? `，最近一轮严重 ${last.severe.length} / 建议 ${last.minor.length}` : ''}`,
    ].join('\n')
  }
  return renderFinalReport(state, state.result?.summary ?? '')
}
