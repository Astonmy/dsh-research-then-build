import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canFinish, createState, isActive, lastCritique, recordCritique, recordResearch, shouldProbe } from '../lib/state.js'

const BASE = () => createState({ task: '给项目加用户登录', maxRounds: 3 })
const dirty = (n = 1) => ({
  converged: false,
  severe: Array.from({ length: n }, (_, i) => ({ title: `问题${i + 1}` })),
  minor: [],
})
const clean = () => ({ converged: true, severe: [], minor: [] })

test('新状态是 active，且不允许直接交付', () => {
  const state = BASE()
  assert.equal(isActive(state), true)
  const verdict = canFinish(state)
  assert.equal(verdict.ok, false)
  assert.ok(verdict.reason.includes('台账'))
})

test('有台账但没经过独立检查时不允许交付', () => {
  const state = BASE()
  recordResearch(state, '## 能力点：登录\n- 结论：采用 Auth.js')
  const verdict = canFinish(state)
  assert.equal(verdict.ok, false)
  assert.ok(verdict.reason.includes('look_challenge'))
})

test('台账与检查都有、最后收敛时放行', () => {
  const state = BASE()
  recordResearch(state, '## 能力点：登录\n- 结论：采用 Auth.js')
  recordCritique(state, clean(), 'fp-1')
  assert.equal(canFinish(state, 'fp-1').ok, true)
})

test('最后一轮仍有严重问题且轮次未用尽时不允许交付', () => {
  const state = BASE()
  recordResearch(state, '## 能力点：登录\n- 结论：采用 Auth.js')
  recordCritique(state, dirty(2), 'fp-1')
  const verdict = canFinish(state, 'fp-1')
  assert.equal(verdict.ok, false)
  assert.ok(verdict.reason.includes('2 条严重问题'))
})

test('用尽轮次后允许交付，哪怕问题仍在', () => {
  const state = BASE()
  recordResearch(state, '## 能力点：登录\n- 结论：采用 Auth.js')
  for (let i = 0; i < 3; i++) recordCritique(state, dirty(1), 'fp-1')
  assert.equal(state.rounds.length, 3)
  assert.equal(canFinish(state, 'fp-1').ok, true)
})

test('检查之后代码又变了：结论过期，不放行', () => {
  const state = BASE()
  recordResearch(state, '## 能力点：登录\n- 结论：采用 Auth.js')
  recordCritique(state, clean(), 'fp-1')
  const verdict = canFinish(state, 'fp-2')
  assert.equal(verdict.ok, false)
  assert.ok(verdict.reason.includes('过期'))
})

test('没有指纹的旧记录不会因为比对而误伤', () => {
  const state = BASE()
  recordResearch(state, '## 能力点：登录\n- 结论：采用 Auth.js')
  recordCritique(state, clean(), '')
  assert.equal(canFinish(state, 'fp-anything').ok, true)
})

test('达到严重问题上限后，清理性复检仍可放行', () => {
  const state = BASE()
  recordResearch(state, '## 能力点：登录\n- 结论：采用 Auth.js')
  for (let i = 0; i < 3; i++) recordCritique(state, dirty(1), 'fp-old')
  recordCritique(state, clean(), 'fp-new')
  assert.equal(state.rounds.length, 4)
  assert.equal(canFinish(state, 'fp-new').ok, true)
  // 复检之后又改代码 → 又过期
  assert.equal(canFinish(state, 'fp-newer').ok, false)
})

test('退出后的状态不再放行', () => {
  const state = BASE()
  recordResearch(state, '## 能力点：登录\n- 结论：采用 Auth.js')
  recordCritique(state, clean(), 'fp-1')
  state.state = 'closed'
  assert.equal(isActive(state), false)
  assert.equal(canFinish(state, 'fp-1').ok, false)
})

test('多次调研累积成一份台账，不互相覆盖', () => {
  const state = BASE()
  recordResearch(state, '## 能力点：登录\n- 结论：采用 Auth.js')
  recordResearch(state, '## 能力点：上传\n- 结论：采用 tus')
  assert.ok(state.ledger.includes('Auth.js'))
  assert.ok(state.ledger.includes('tus'))
})

test('追问调度：默认只在收敛或最后一轮跑', () => {
  assert.equal(shouldProbe({ critique: dirty(1), round: 1, maxRounds: 3 }), false)
  assert.equal(shouldProbe({ critique: clean(), round: 1, maxRounds: 3 }), true)
  assert.equal(shouldProbe({ critique: dirty(1), round: 3, maxRounds: 3 }), true)
  assert.equal(shouldProbe({ critique: dirty(1), round: 1, maxRounds: 3, probe: 'every' }), true)
})

test('轮次编号递增且 lastCritique 指向最近一轮', () => {
  const state = BASE()
  recordCritique(state, dirty(1), 'fp-1')
  recordCritique(state, clean(), 'fp-2')
  assert.equal(state.rounds[0].round, 1)
  assert.equal(state.rounds[1].round, 2)
  assert.equal(lastCritique(state).converged, true)
})
