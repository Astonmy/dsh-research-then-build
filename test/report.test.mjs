import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatCritique,
  formatResidue,
  parseConfidence,
  parseCritique,
  parseOmissions,
  renderFinalReport,
  renderStatus,
  validateLedger,
} from '../lib/report.js'
import { createState, recordCritique, recordResearch } from '../lib/state.js'

test('解析围栏 JSON，并把非空 severe 视为未收敛', () => {
  const raw = '先说两句\n```json\n{"converged": true, "severe": [], "minor": [{"title": "缺少超时", "where": "server.js:12"}]}\n```\n完'
  const critique = parseCritique(raw)
  assert.equal(critique.converged, true)
  assert.equal(critique.minor.length, 1)
  assert.equal(critique.minor[0].where, 'server.js:12')
})

test('解析夹在废话里的裸 JSON', () => {
  const raw = '前言 {"converged": false, "severe": [{"title": "绕开台账", "where": "auth.js", "why": "手写 session"}], "minor": []} 后记'
  const critique = parseCritique(raw)
  assert.equal(critique.converged, false)
  assert.equal(critique.severe[0].title, '绕开台账')
})

test('converged 标记与 severe 冲突时以 severe 为准', () => {
  const critique = parseCritique('{"converged": true, "severe": [{"title": "功能遗漏"}], "minor": []}')
  assert.equal(critique.converged, false)
})

test('不是 JSON 时返回 null，而不是编造结论', () => {
  assert.equal(parseCritique('这是一段说明，没有 JSON。'), null)
})

test('台账缺少能力点或结论时判定不可用', () => {
  assert.equal(validateLedger('## 能力点：登录\n- 结论：采用 Auth.js').ok, true)
  assert.equal(validateLedger('能力点：登录，结论：采用 Auth.js').ok, true)
  const empty = validateLedger('我搜了一下，感觉用 Auth.js 就行。')
  assert.equal(empty.ok, false)
  assert.deepEqual(empty.missing, ['能力点', '结论'])
  assert.deepEqual(validateLedger('## 能力点：登录\n- 候选：Auth.js').missing, ['结论'])
})

test('报了 severe 却一条都提取不出来时不当作通过', () => {
  const raw = '{"converged": true, "severe": [{"title": "", "why": ""}], "minor": []}'
  assert.equal(parseCritique(raw), null)
})

test('formatted critique 带上位置与原因', () => {
  const text = formatCritique({ converged: false, severe: [{ title: '假证据', where: '台账第 2 条', why: '该包不存在' }], minor: [] })
  assert.ok(text.includes('假证据'))
  assert.ok(text.includes('台账第 2 条'))
})

test('交付报告包含台账、检查轮次与未解决问题', () => {
  const state = createState({ task: '给项目加登录', maxRounds: 2 })
  recordResearch(state, '## 能力点：登录\n- 结论：采用 Auth.js')
  recordCritique(state, { converged: false, severe: [{ title: '绕开台账', where: 'login.js:1', why: '手写' }], minor: [] })
  recordCritique(state, { converged: false, severe: [{ title: '未验证', where: '摘要', why: '没有证据' }], minor: [] })
  const report = renderFinalReport(state, '改了 login.js，跑了 node --test')
  assert.ok(report.includes('已交付'))
  assert.ok(report.includes('Auth.js'))
  assert.ok(report.includes('第 2 轮'))
  assert.ok(report.includes('仍未解决的严重问题'))
  assert.ok(report.includes('node --test'))
})

test('进行中的状态显示还缺什么', () => {
  const state = createState({ task: 'x', maxRounds: 3 })
  const active = renderStatus(state)
  assert.ok(active.includes('进行中'))
  assert.ok(active.includes('还没有'))
})

test('主动退出与已交付在状态里区分开', () => {
  const exited = createState({ task: 'x', maxRounds: 3 })
  exited.state = 'closed'
  exited.result = { summary: '（用户主动退出，未交付）', exited: true }
  assert.ok(renderStatus(exited).includes('已退出'))
  assert.ok(!renderStatus(exited).includes('已交付'))
})

test('遗漏追问与把握盘点的解析', () => {
  const omissions = parseOmissions('```json\n{"omissions":[{"title":"没看测试","where":"test/","why":"无法验证"}]}\n```')
  assert.equal(omissions.length, 1)
  assert.equal(omissions[0].title, '没看测试')
  assert.equal(parseOmissions('不是 JSON'), null)

  const confident = parseConfidence('{"confident":[{"what":"门禁生效","basis":"读了 state.js"}]}')
  assert.equal(confident[0].basis, '读了 state.js')
  assert.equal(parseConfidence('{"confident":"没有"}'), null)
})

test('报告的残留段区分「没被覆盖」与「有把握」', () => {
  const lines = formatResidue({
    omissions: [{ title: '没看测试', where: 'test/', why: '无法验证' }],
    omissionsOk: true,
    confident: [{ what: '门禁生效', basis: '读了 state.js' }],
  }).join('\n')
  assert.ok(lines.includes('没被覆盖到的地方'))
  assert.ok(lines.includes('没看测试'))
  assert.ok(lines.includes('有把握的部分'))
  assert.ok(lines.includes('读了 state.js'))
})

test('遗漏追问没返回 JSON 时明确标注，而不是冒充"没有遗漏"', () => {
  const lines = formatResidue({ omissions: [], omissionsOk: false, confident: [] }).join('\n')
  assert.ok(lines.includes('没有拿到遗漏清单'))
})

test('本次未追问时如实标注，而不是显示"没有遗漏"', () => {
  const lines = formatResidue({ probed: false, omissions: [], confident: [] }).join('\n')
  assert.ok(lines.includes('本轮未追问'))
  assert.ok(!lines.includes('没有发现未覆盖'))
})

test('severe 不是数组或 converged 不是布尔时视为形状异常', () => {
  assert.equal(parseCritique('{"converged": true, "severe": "无", "minor": []}'), null)
  assert.equal(parseCritique('{"converged": true}'), null)
  assert.equal(parseCritique('{"converged": "false", "severe": [], "minor": []}'), null)
  assert.equal(parseCritique('{"converged": {"title": "x"}}'), null)
})
