// 会员页「批量新增」20 条正常数据 · 全管线实测探针（2026-09-06）
// 对应数据文档：src/doc/cards-import-paste-normal-20.md（文本源：scripts/normal20-rows.mjs）
// 覆盖：前端管线（parseCardsText → mergeImportRows → classifyImport → buildImportPayload）
//       + 幂等回贴（更新分支）+ 表头别名变体 + 全分支补充断言
//       + CF 层校验兜底（functions/api/cards/import.js）。
// 运行：node scripts/probe-import-normal20.mjs
// 注意：数据与运行日 2026-09-06 绑定（配置 A/B 端点行），换天运行请先调整文档中的边界行。

import {
  addYearsClamped,
  buildImportPayload,
  classifyImport,
  ddlMax,
  mergeImportRows,
  parseCardsText,
  startDateMin,
  todayISO,
} from '../src/lib/cardsDomain.js'
import { onRequestPost } from '../functions/api/cards/import.js'
import { NORMAL20_TEXT } from './normal20-rows.mjs'

const TODAY = todayISO()
const EXPECT_TODAY = '2026-09-06'

let failed = 0
function check(name, cond, detail = '') {
  if (!cond) {
    failed++
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

if (TODAY !== EXPECT_TODAY) {
  console.log(`✗ 运行日不匹配：todayISO()=${TODAY}，本探针与数据文档按 ${EXPECT_TODAY} 设计（配置 A/B 端点行换天会失效）`)
  process.exit(1)
}
console.log(`运行日 = ${TODAY}（配置 A 下限 ${startDateMin(TODAY)}，配置 B 上限 ${ddlMax(TODAY)}）`)

const NORMAL20 = NORMAL20_TEXT

function runPipeline(text, loaded) {
  const parsed = parseCardsText(text)
  const merged = mergeImportRows(parsed.rows)
  const result = classifyImport(merged, loaded, TODAY)
  return { parsed, merged, result }
}

// ── A. 正常新增跑（空库快照） ────────────────────────────────────────────────
console.log('\n[A] 20 条正常数据 · 空库新增跑')
{
  const { parsed, merged, result } = runPipeline(NORMAL20, [])
  check('A1 解析零错误', parsed.errors.length === 0, JSON.stringify(parsed.errors))
  check('A2 合并后 20 行（卡名全唯一）', merged.length === 20)
  check('A3 creates=20 / updates=0 / errors=0',
    result.creates.length === 20 && result.updates.length === 0 && result.errors.length === 0,
    JSON.stringify(result.errors))
  check('A4 行号口径：首条数据行 __line=2（表头占第 1 行）', merged[0]?.__line === 2, `__line=${merged[0]?.__line}`)

  const byName = Object.fromEntries(result.creates.map((c) => [c.row.name, c]))
  const labelsOf = (c) => c.defaults.map((d) => d.label)
  const defaultValueOf = (c, label) => c.defaults.find((d) => d.label === label)?.value

  const c1 = byName['只有名字的默认卡']
  check('A5 只带卡名行三项默认（起始/终止/续费）',
    c1 && labelsOf(c1).join(',') === '起始日期,终止日期,自动续费' && defaultValueOf(c1, '终止日期') === '今天 + 2 年',
    JSON.stringify(c1?.defaults))
  const c2 = byName['年费会员卡']
  check('A6 起止齐全行只默认续费=关', c2 && labelsOf(c2).join(',') === '自动续费', JSON.stringify(c2?.defaults))
  const c3 = byName['Tab分隔月卡']
  check('A7 Tab 分隔行落位正确', c3?.row.start_date === '2026-09-01' && c3?.row.end_date === '2026-09-30')
  const c4 = byName['单日体验卡']
  check('A8 空格分隔行落位正确 + DDL=起始日',
    c4?.row.start_date === '2026-09-06' && c4?.row.end_date === '2026-09-06')
  const c5 = byName['已结束历史留档卡']
  check('A9 行过期+库内没有 → insert_expired（正常插入留档）', c5?.action === 'insert_expired', c5?.action)
  const c6 = byName['满次体验30次卡']
  check('A10 次卡缺终止日期 → 默认标注 + 次数能力开启',
    c6 && labelsOf(c6).includes('终止日期') && c6.sessionsOn === true && labelsOf(c6).includes('自动续费'),
    JSON.stringify(c6?.defaults))
  check('A11 次数半程 7/10', byName['半程7次卡']?.row.remaining_sessions === 7 && byName['半程7次卡']?.row.total_sessions === 10)
  check('A12 剩最后 1 次', byName['最后1次卡']?.row.remaining_sessions === 1)
  check('A13 剩余 0 合法（用完形态）', byName['已用完20次卡']?.row.remaining_sessions === 0)
  check('A14 remaining=1 / total=1 双下界合法',
    byName['双下界次卡']?.row.remaining_sessions === 1 && byName['双下界次卡']?.row.total_sessions === 1)
  check('A15 配置 A 下端点含入合法', byName['配置A下端点卡']?.row.start_date === startDateMin(TODAY))
  check('A16 配置 B 上端点含入合法', byName['配置B上端点卡']?.row.end_date === ddlMax(TODAY))

  const renewNames = ['连续包周卡', '连续包月卡', '连续包季卡', '连续包年卡', '合同45天卡', '合同7天次卡', '月度团课30次续费卡', '全字段演示卡']
  const cycles = { 连续包周卡: ['week', '2026-09-13'], 连续包月卡: ['month', '2026-10-06'], 连续包季卡: ['quarter', '2026-12-06'], 连续包年卡: ['year', '2027-09-06'], 合同45天卡: [null, '2026-10-20'], 合同7天次卡: [null, '2026-09-12'], 月度团课30次续费卡: ['month', '2026-10-01'], 全字段演示卡: ['month', '2026-10-06'] }
  for (const name of renewNames) {
    const c = byName[name]
    check(`A17 ${name}：扣款日强制 = 终止日期 + 「扣款日」默认标注`,
      c?.row.auto_renew === true && c?.row.next_billing_date === cycles[name][1] && defaultValueOf(c, '扣款日') === cycles[name][1],
      JSON.stringify({ nbd: c?.row.next_billing_date, defaults: c?.defaults }))
    if (cycles[name][0]) check(`A17b ${name}：周期=${cycles[name][0]}`, c?.row.billing_cycle === cycles[name][0], c?.row.billing_cycle)
  }
  check('A18 合同45天卡 period_days=45', byName['合同45天卡']?.row.period_days === 45)
  check('A19 合同7天次卡：天数+次数组合，次数能力开启',
    byName['合同7天次卡']?.row.period_days === 7 && byName['合同7天次卡']?.sessionsOn === true)
  check('A20 全字段演示卡：行内扣款日 2026-10-01 被忽略，落 2026-10-06',
    byName['全字段演示卡']?.row.next_billing_date === '2026-10-06')

  const insertCount = result.creates.filter((c) => c.action === 'insert').length
  const expiredCount = result.creates.filter((c) => c.action === 'insert_expired').length
  const renewTotal = result.creates.filter((c) => c.row.auto_renew === true).length
  const sessionsTotal = result.creates.filter((c) => c.sessionsOn).length
  check('A21 汇总：insert 19 + insert_expired 1 + 续费 8 + 次数能力 8',
    insertCount === 19 && expiredCount === 1 && renewTotal === 8 && sessionsTotal === 8,
    `insert=${insertCount} expired=${expiredCount} renew=${renewTotal} sessions=${sessionsTotal}`)

  const payload = buildImportPayload(result)
  check('A22 载荷 20 行且都带卡名', payload.length === 20 && payload.every((r) => typeof r.name === 'string' && r.name.length > 0))
  check('A23 载荷无显式 null / undefined 值键',
    payload.every((r) => Object.values(r).every((v) => v !== null && v !== undefined)))
  check('A24 载荷中全字段演示卡扣款日=2026-10-06（行内 2026-10-01 不入载荷）',
    payload.find((r) => r.name === '全字段演示卡')?.next_billing_date === '2026-10-06')

  // ── B. 表头别名变体：9 个别名表头 → 分类结果一致 ────────────────────────────
  console.log('\n[B] 表头别名变体（名称/开始日期/有效期至/余次/共/续费/周期/天数/下次扣款）')
  const aliasText = NORMAL20.replace(
    '卡名,起始日,终止日期,剩余次数,每周期次数,自动续费,扣款周期,合同天数,扣款日',
    '名称,开始日期,有效期至,余次,共,续费,周期,天数,下次扣款'
  )
  const alias = runPipeline(aliasText, [])
  check('B1 别名表头识别零错误', alias.parsed.errors.length === 0, JSON.stringify(alias.parsed.errors))
  check('B2 别名变体分类结果与 canonical 完全一致（20 新增 0 错误）',
    alias.result.creates.length === 20 && alias.result.errors.length === 0 &&
    JSON.stringify(alias.result.creates) === JSON.stringify(result.creates))
  // 附带发现（2026-09-06 实测）：表头里不认识的列名（如「余数」≠「余次」）会被
  // 静默忽略（该列丢弃），后续行按错位语义解析——用「余数」替换「余次」重放时
  // 8 条带次数的行会以「新增行只带每周期次数、缺剩余次数」行报错，提交被门禁拦截。
  const wrongAlias = runPipeline(
    aliasText.replace('余次', '余数'), []
  )
  check('B3 伪别名「余数」列被静默忽略 → 8 条带次数行报「缺剩余次数」并阻断提交',
    wrongAlias.parsed.errors.length === 0 &&
    wrongAlias.result.errors.length === 8 &&
    wrongAlias.result.errors.every((e) => e.reason === '新增行只带每周期次数、缺剩余次数'),
    JSON.stringify(wrongAlias.result.errors.map((e) => e.line)))

  // ── C. 幂等回贴：提交后同数据再贴 → 全部转「更新」且无字段变化 ────────────────
  console.log('\n[C] 幂等回贴（模拟落库后快照，SQL INSERT 默认值同款物化）')
  const library = result.creates.map(({ row }) => ({
    id: row.name,
    name: row.name,
    start_date: row.start_date ?? TODAY,
    end_date: row.end_date ?? addYearsClamped(TODAY, 2),
    remaining_sessions: row.remaining_sessions ?? null,
    total_sessions: row.total_sessions ?? null,
    auto_renew: row.auto_renew ?? false,
    billing_cycle: row.billing_cycle ?? null,
    period_days: row.period_days ?? null,
    next_billing_date: row.auto_renew === true ? (row.end_date ?? addYearsClamped(TODAY, 2)) : row.next_billing_date ?? null,
    muted: 'none',
  }))
  const again = runPipeline(NORMAL20, library)
  const againByName = Object.fromEntries(again.result.updates.map((u) => [u.row.name, u]))
  check('C1 回贴 creates=0 / updates=20 / errors=0',
    again.result.creates.length === 0 && again.result.updates.length === 20 && again.result.errors.length === 0)
  const noDiff = again.result.updates.filter((u) => u.diff.length === 0).length
  check('C2 19 条 action=update、skip 行 diff 也为空（20 条全部无字段变化）',
    again.result.updates.filter((u) => u.action === 'update').length === 19 && noDiff === 20,
    `noDiff=${noDiff}`)
  check('C3 已结束历史留档卡 → skip_expired（库内已过期跳过）',
    againByName['已结束历史留档卡']?.action === 'skip_expired')
  const renewOn = againByName['连续包月卡']
  check('C4 续费卡回贴：扣款日仍=终止日期（强制对齐，不产生 diff）',
    renewOn && renewOn.diff.length === 0 && renewOn.ignoredBilling === false &&
    renewOn.ignoredSessions === false)
  check('C5 次卡回贴：次数能力已开 → 次数字段正常写入（不触发忽略）',
    againByName['满次体验30次卡'] && againByName['满次体验30次卡'].diff.length === 0)
  check('C6 skip_expired 行仍进提交载荷（RPC 内同规则跳过）',
    buildImportPayload(again.result).length === 20)
}

// ── E. 全分支补充断言（解析变体 / 校验短路 / 边界形态 / 更新形态） ─────────────
console.log('\n[E] 全分支补充断言')
{
  const p = (text, loaded = []) => {
    const parsed = parseCardsText(text)
    const merged = mergeImportRows(parsed.rows)
    return { parsed, merged, result: classifyImport(merged, loaded, TODAY) }
  }

  // E1 无表头 → 默认 9 列列序
  const canonical = p(NORMAL20, [])
  const noHeader = p(NORMAL20.split('\n').slice(1).join('\n'), [])
  const stripCreateLine = (r) => JSON.stringify(r.creates.map(({ line: _line, ...rest }) => rest))
  check('E1 无表头按默认列序解析 → 与带表头分类结果一致（仅行号偏移）',
    noHeader.parsed.errors.length === 0 && noHeader.result.errors.length === 0 &&
    stripCreateLine(noHeader.result) === stripCreateLine(canonical.result))

  // E2 日期归一化变体 + 无效日期严格校验（脏单元格降级，行不废弃）
  const e2 = p([
    '日期变体卡,2026/9/1,2026.12.31',
    '单数位卡,2026-9-3',
    '坏日期卡,2026-2-30,2027-01-01',
  ].join('\n'))
  const e2byName = Object.fromEntries(e2.result.creates.map((c) => [c.row.name, c.row]))
  check('E2a 2026/9/1 与 2026.12.31 归一化 ISO',
    e2byName['日期变体卡']?.start_date === '2026-09-01' && e2byName['日期变体卡']?.end_date === '2026-12-31')
  check('E2b 单数位 2026-9-3 归一化', e2byName['单数位卡']?.start_date === '2026-09-03')
  check('E2c 2026-2-30 严格校验报「不是有效日期」；该字段丢弃后行仍带终止日期进新增预览',
    e2.parsed.errors.length === 1 && e2.parsed.errors[0].reason === '起始日期「2026-2-30」不是有效日期' &&
    e2.result.creates.length === 3 && e2byName['坏日期卡']?.end_date === '2027-01-01',
    JSON.stringify(e2.parsed.errors))

  // E3 自动续费取值变体（正/反/乱值降级）；续费开行缺周期/天数在分类层触发 4-B27
  const e3 = p([
    '卡名,自动续费',
    'A卡,true', 'B卡,YES', 'C卡,开', 'D卡,1',
    'E卡,0', 'F卡,关', 'G卡,False', 'H卡,n', 'I卡,否', 'J卡,也许',
  ].join('\n'))
  const e3rowByName = Object.fromEntries(e3.parsed.rows.map((r) => [r.name, r]))
  check('E3a true/YES/开/1 → 开；0/关/False/n/否 → 关（解析层）',
    ['A卡', 'B卡', 'C卡', 'D卡'].every((n) => e3rowByName[n]?.auto_renew === true) &&
    ['E卡', 'F卡', 'G卡', 'H卡', 'I卡'].every((n) => e3rowByName[n]?.auto_renew === false))
  check('E3b 乱值「也许」→ 行报错 + 字段丢弃（卡名仍进新增预览）',
    e3.parsed.errors.length === 1 && e3.parsed.errors[0].reason === '自动续费「也许」无法识别（用 是/否）' &&
    e3.parsed.rows.find((r) => r.name === 'J卡')?.auto_renew === undefined &&
    e3.result.creates.some((c) => c.row.name === 'J卡'))
  check('E3c 续费开且无周期/天数的 4 行 → 分类层各报 4-B27 行错误',
    e3.result.errors.length === 4 &&
    e3.result.errors.every((e) => e.reason === '开启自动续费需选择扣款周期或填写合同天数'),
    JSON.stringify(e3.result.errors))

  // E4 扣款周期取值变体（英文 key 大小写不敏感 / 中文 / 乱值）
  const e4 = p(['卡名,扣款周期', 'A卡,week', 'B卡,Month', 'C卡,季', 'D卡,YEAR', 'E卡,半年'].join('\n'))
  const e4byName = Object.fromEntries(e4.result.creates.map((c) => [c.row.name, c.row]))
  check('E4 week/Month/季/YEAR 归一化 key；半年 → 行报错',
    e4byName['A卡']?.billing_cycle === 'week' && e4byName['B卡']?.billing_cycle === 'month' &&
    e4byName['C卡']?.billing_cycle === 'quarter' && e4byName['D卡']?.billing_cycle === 'year' &&
    e4.parsed.errors.length === 1 && e4.parsed.errors[0].reason === '扣款周期「半年」无法识别（周/月/季/年）',
    JSON.stringify(e4.parsed.errors))

  // E5 非整数次数文本
  const e5 = p(['卡名,剩余次数', 'A卡,8.5', 'B卡,8次'].join('\n'))
  check('E5 8.5 / 8次 → 「不是整数」',
    e5.parsed.errors.length === 2 && e5.parsed.errors.every((e) => e.reason.endsWith('不是整数')))

  // E6 空行过滤 + 行号按过滤后非空行序计数；坏单元格行仍以卡名进合并（降级不丢行）
  const e6 = p(['A卡,2026-09-01', '', '   ', '坏行,2026-2-30', ''].join('\n'))
  check('E6 空行被过滤；错误行号=过滤后序号 2（≠物理行 4）；坏行保留卡名进合并',
    e6.merged.length === 2 && e6.parsed.errors.length === 1 && e6.parsed.errors[0].line === 2 &&
    e6.merged.some((r) => r.name === '坏行'),
    JSON.stringify(e6.parsed.errors))

  // E7 无卡名两分支
  const e7 = p([',2026-09-01', ',,,,,,,,,,'].join('\n'))
  check('E7 有字段无卡名 →「卡名为空」；全空行 →「缺少字段（至少需要 卡名 一列）」',
    e7.parsed.errors.length === 2 && e7.parsed.errors[0].reason === '卡名为空' &&
    e7.parsed.errors[1].reason === '缺少字段（至少需要 卡名 一列）',
    JSON.stringify(e7.parsed.errors))

  // E8 超出列数的多余列静默忽略
  const e8 = p('A卡,2026-09-06,2027-09-06,1,2,是,月,,2026-10-06,这一列是多余的', [])
  check('E8 第 10 列静默忽略，正常新增（扣款日仍强制=DDL）',
    e8.result.creates.length === 1 && e8.result.errors.length === 0 &&
    e8.result.creates[0].row.next_billing_date === '2027-09-06')

  // E9 空文本 / 纯空白 → 0 行 0 错（页面不渲染预览为 GUI 核对项）
  const e9 = p('   \n  \n')
  check('E9 纯空白输入解析为 0 行 0 错', e9.merged.length === 0 && e9.parsed.errors.length === 0)

  // E10 起始日 > 今天 + 行级校验短路（一行多错只报第一处）
  const e10 = p([
    '卡名,起始日,终止日期,自动续费,扣款周期,合同天数',
    '未来卡,2026-09-07',
    '短路卡,2024-01-01,2026-10-01,是,月,30',
  ].join('\n'))
  check('E10a 起始日在未来 → 报配置 A 错误',
    e10.result.errors.some((e) => e.line === 2 && e.reason === '起始日期需在 2024-09-06 至 2026-09-06 之间（配置 A）'))
  check('E10b 短路卡（起始越界+互斥并存）只报第一处配置 A 错误',
    e10.result.errors.filter((e) => e.line === 3).length === 1 &&
    e10.result.errors.find((e) => e.line === 3)?.reason.startsWith('起始日期需在'),
    JSON.stringify(e10.result.errors.filter((e) => e.line === 3)))

  // E11 终止日期早于起始日期（新增行 & 更新行按库内起始日合成判定）
  const e11a = p('倒挂卡,2026-09-06,2026-09-05', [])
  const e11b = p('倒挂更新卡,,2026-08-31', [
    { id: 'x', name: '倒挂更新卡', start_date: '2026-09-01', end_date: '2027-01-01',
      remaining_sessions: null, total_sessions: null, auto_renew: false,
      billing_cycle: null, period_days: null, next_billing_date: null, muted: 'none' },
  ])
  check('E11a 新增行 DDL < 起始日 → 报错', e11a.result.errors.length === 1 && e11a.result.errors[0].reason === '终止日期早于起始日期')
  check('E11b 更新行 DDL < 库内起始日（行内未带起始日）→ 同样报错',
    e11b.result.errors.length === 1 && e11b.result.errors[0].reason === '终止日期早于起始日期',
    JSON.stringify(e11b.result.errors))

  // E12 JS 侧负剩余 / 零天数
  const e12 = p(['卡名,剩余次数,合同天数', 'A卡,-1', 'B卡,,0'].join('\n'))
  check('E12 剩余 -1 →「不能为负数」；天数 0 →「需为正整数」',
    e12.result.errors.length === 2 &&
    e12.result.errors[0].reason === '剩余次数不能为负数' && e12.result.errors[1].reason === '合同天数需为正整数',
    JSON.stringify(e12.result.errors))

  // E13 新增行续费开但缺周期/天数
  const e13 = p(['卡名,自动续费', 'A卡,是'].join('\n'))
  check('E13 开启自动续费缺周期/天数 → 行报错（4-B27）',
    e13.result.errors.length === 1 &&
    e13.result.errors[0].reason === '开启自动续费需选择扣款周期或填写合同天数')

  // E14 DDL = 今天：不判过期（行判定过期 = DDL < 今天），正常 insert
  const e14 = p('今天到期卡,2026-09-01,2026-09-06', [])
  check('E14 DDL=今天 → insert（非 insert_expired）',
    e14.result.creates.length === 1 && e14.result.creates[0].action === 'insert')

  // E15 翻转续费关：diff 只显示 开→关，库内扣款字段保留（4-B20）
  const e15 = p(['卡名,自动续费', 'X卡,否'].join('\n'), [
    { id: 'x', name: 'X卡', start_date: '2026-09-01', end_date: '2026-10-01',
      remaining_sessions: null, total_sessions: null, auto_renew: true,
      billing_cycle: 'month', period_days: null, next_billing_date: '2026-10-01', muted: 'none' },
  ])
  const e15u = e15.result.updates[0]
  check('E15 翻转续费关：diff 仅 自动续费 开→关，扣款字段保留不进 diff',
    e15u && e15u.diff.length === 1 && e15u.diff[0].field === 'auto_renew' &&
    e15u.diff[0].old === true && e15u.diff[0].new === false &&
    e15u.ignoredBilling === false && e15u.action === 'update',
    JSON.stringify(e15u?.diff))
}

// ── D. CF 层兜底校验（functions/api/cards/import.js，stub Supabase fetch） ────
console.log('\n[D] CF 层兜底校验分支')
{
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return new Response(JSON.stringify([{ id: 'stub' }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  const ctx = (payload) => ({
    env: { SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_ANON_KEY: 'stub-anon' },
    data: { accessToken: 'stub-token' },
    request: new Request('https://stub.supabase.co/api/cards/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  })
  const call = async (payload) => {
    calls.length = 0
    const res = await onRequestPost(ctx(payload))
    return { status: res.status, body: await res.json(), forwarded: calls[0] }
  }

  let r = await call({ rows: [], today: TODAY })
  check('D1 空数组 → 400 没有可提交的数据', r.status === 400 && r.body.error === '没有可提交的数据')
  r = await call({ rows: [{}], today: TODAY })
  check('D2 缺卡名 → 400 第 1 行：缺少卡名', r.status === 400 && r.body.error === '第 1 行：缺少卡名')
  r = await call({ rows: [{ name: '   ' }], today: TODAY })
  check('D3 纯空白卡名 → 400 缺少卡名（trim 后判空）', r.status === 400 && r.body.error === '第 1 行：缺少卡名')

  r = await call({
    rows: [{ name: '  边界清洗卡  ', start_date: '2026-09-06', extra_key: 'x', total_sessions: null }],
    today: TODAY,
  })
  const fwd = r.forwarded?.body?.p_rows?.[0]
  check('D4 卡名 trim + 白名单外键剥离 + 显式 null 键剥离 → 转发 RPC',
    r.status === 200 && fwd?.name === '边界清洗卡' && !('extra_key' in fwd) && !('total_sessions' in fwd),
    JSON.stringify(fwd))
  check('D4b 转发地址 = SUPABASE_URL/rest/v1/rpc/import_my_cards',
    r.forwarded?.url === 'https://stub.supabase.co/rest/v1/rpc/import_my_cards')

  r = await call({ rows: [{ name: 'A下越界', start_date: '2024-09-05' }], today: TODAY })
  check('D5 起始日期 < 配置 A 下限 → 400', r.status === 400 && r.body.error === '第 1 行：起始日期需在 2024-09-06 至 2026-09-06 之间', r.body.error)
  r = await call({ rows: [{ name: 'A上越界', start_date: '2026-09-07' }], today: TODAY })
  check('D6 起始日期 > 今天 → 400 同文案', r.status === 400 && r.body.error === '第 1 行：起始日期需在 2024-09-06 至 2026-09-06 之间')
  r = await call({ rows: [{ name: '坏日期', start_date: '2026-09-31' }], today: TODAY })
  check('D7 起始日期格式无效 → 400', r.status === 400 && r.body.error === '第 1 行：起始日期格式无效')
  r = await call({ rows: [{ name: 'B越界', end_date: '2028-09-07' }], today: TODAY })
  check('D8 终止日期 > 配置 B 上限 → 400', r.status === 400 && r.body.error === '第 1 行：终止日期不能晚于 2028-09-06（配置 B）', r.body.error)
  r = await call({ rows: [{ name: '坏DDL', end_date: '2026-13-01' }], today: TODAY })
  check('D9 终止日期格式无效 → 400', r.status === 400 && r.body.error === '第 1 行：终止日期格式无效')
  r = await call({ rows: [{ name: '负次数', remaining_sessions: -1 }], today: TODAY })
  check('D10a 剩余次数 < 0 → 400', r.status === 400 && r.body.error === '第 1 行：剩余次数需不小于 0')
  r = await call({ rows: [{ name: '小数次数', remaining_sessions: 1.5 }], today: TODAY })
  check('D10b 剩余次数非整数 → 400', r.status === 400 && r.body.error === '第 1 行：剩余次数需为整数')
  r = await call({ rows: [{ name: '零总次', total_sessions: 0 }], today: TODAY })
  check('D11 每周期次数 0 → 400', r.status === 400 && r.body.error === '第 1 行：每周期次数需不小于 1')
  r = await call({ rows: [{ name: '零天数', period_days: 0 }], today: TODAY })
  check('D12 合同天数 0 → 400', r.status === 400 && r.body.error === '第 1 行：合同天数需不小于 1')
  r = await call({ rows: [{ name: '字符串续费', auto_renew: '是' }], today: TODAY })
  check('D13 auto_renew 非布尔 → 400', r.status === 400 && r.body.error === '第 1 行：auto_renew 需为布尔值')
  r = await call({ rows: [{ name: '乱周期', billing_cycle: '半年' }], today: TODAY })
  check('D14 扣款周期枚举无效 → 400', r.status === 400 && r.body.error === '第 1 行：扣款周期枚举无效')
  r = await call({ rows: [{ name: '双表示', billing_cycle: 'month', period_days: 30 }], today: TODAY })
  check('D15 周期+天数并存 → 400 只能二选一', r.status === 400 && r.body.error === '第 1 行：扣款周期与合同天数只能二选一')
  r = await call({ rows: [{ name: '坏扣款日', next_billing_date: '2026-02-30' }], today: TODAY })
  check('D16 扣款日格式无效 → 400（不校验窗口）', r.status === 400 && r.body.error === '第 1 行：扣款日格式无效')

  r = await call({
    rows: [{ name: '端点合法行', start_date: '2024-09-06', end_date: '2028-09-06', remaining_sessions: 0, total_sessions: 1, period_days: 1 }],
    today: TODAY,
  })
  check('D17 配置 A/B 端点 + 数值下界全部含入合法 → 转发 RPC', r.status === 200 && r.forwarded?.body?.p_rows?.length === 1)
  r = await call({ rows: [{ name: '非法today回退', start_date: '2026-09-06' }], today: 'not-a-date' })
  check('D18 today 非法 → 回退服务器口径放行', r.status === 200)

  globalThis.fetch = realFetch
}

console.log('')
if (failed > 0) {
  console.log(`${failed} 个断言失败`)
  process.exit(1)
}
console.log('全部断言通过 ✓（A 正常新增跑 / B 别名变体 / C 幂等回贴 / E 全分支补充 / D CF 兜底）')
