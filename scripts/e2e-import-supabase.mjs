// 会员页「批量新增」SQL 侧端到端实测（S 组用例，2026-09-06）
// 真实调用 Supabase：导入 20 条 → 落库校验 → 幂等回贴（skip 用 updated_at 区分）→
// 部分行 coalesce/门控/互斥清洗/续费关保留 → muted='cycle' 解除触发器 →
// 错误分支与整批回滚 → 删除用户清理（cards 级联删除）。
//
// 两种会话来源：
//   A) 默认：创建一次性测试用户 + 密码登录（⚠ 项目开启 Turnstile 后密码登录会被
//      captcha_failed 拒绝——届时请走 B 模式）
//   B) 环境变量 E2E_USER_ID + E2E_ACCESS_TOKEN：复用真实 GUI 登录得到的会话
//      （用户须已存在；推荐路径——GUI 登录自带 Turnstile，见 e2e 说明文档）
//
// 直调 RPC 是 cards-db.md 第 12 节约定的"SQL 侧双实现对账"方式（绕过 CF 层——
// CF 层分支已由 probe-import-normal20.mjs D 组覆盖）。
// 运行：node scripts/e2e-import-supabase.mjs
// ⚠ 结束时会删除测试用户（cards 按 on delete cascade 级联清除）；失败时 finally 仍会尝试清理。

import { readFileSync } from 'node:fs'
import { classifyImport, mergeImportRows, parseCardsText, buildImportPayload, addYearsClamped } from '../src/lib/cardsDomain.js'
import { NORMAL20_TEXT } from './normal20-rows.mjs'

const TODAY = '2026-09-06' // 数据文档设计运行日（本地口径）
const dbToday = new Date().toISOString().slice(0, 10) // DB current_date 口径（UTC）

let failed = 0
function check(name, cond, detail = '') {
  if (!cond) {
    failed++
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function parseDevVars() {
  const vars = {}
  for (const line of readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !line.trim().startsWith('#')) {
      vars[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  return vars
}

const env = parseDevVars()
const SURL = env.SUPABASE_URL
if (!SURL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log('✗ .dev.vars 缺少 SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
console.log(`运行日（本地/客户端口径）= ${TODAY}；DB current_date（UTC 口径）= ${dbToday}` +
  (TODAY !== dbToday ? '（相差 1 天，4-B8 接受范围；物化默认按 DB 口径断言）' : ''))

const adminHeaders = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
}

async function api(method, path, { headers, body } = {}) {
  const res = await fetch(`${SURL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json, text }
}

// ── 前端管线构造载荷（与页面提交完全同源） ────────────────────────────────────
const parsed = parseCardsText(NORMAL20_TEXT)
const payload = buildImportPayload(classifyImport(mergeImportRows(parsed.rows), [], TODAY))
if (payload.length !== 20) {
  console.log(`✗ 管线载荷应为 20 行，实际 ${payload.length}`)
  process.exit(1)
}

const email = process.env.E2E_EMAIL || `e2e-import-${Date.now()}@example.com`
const password = `E2e!${Math.random().toString(36).slice(2)}Aa1!`
const reuseUserId = process.env.E2E_USER_ID || null
const reuseToken = process.env.E2E_ACCESS_TOKEN || null
let userId = reuseUserId
let token = reuseToken
const userHeaders = () => ({ apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

try {
  // ── PHASE 0：会话（B 模式复用 GUI 登录 / A 模式建户 + 密码登录） ─────────────
  console.log(`\n[0] 会话（${reuseToken ? 'B 模式：复用 GUI 会话' : 'A 模式：建户 + 密码登录'}）`)
  if (!reuseToken) {
    let r = await api('POST', '/auth/v1/admin/users', {
      headers: adminHeaders,
      body: { email, password, email_confirm: true },
    })
    check('0.1 admin 创建用户成功', (r.status === 200 || r.status === 201) && r.json?.id, `${r.status} ${r.text.slice(0, 200)}`)
    userId = r.json?.id

    r = await api('POST', '/auth/v1/token?grant_type=password', {
      headers: { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: { email, password, gotrue_meta_security: { captcha_token: process.env.E2E_CAPTCHA_TOKEN || '' } },
    })
    check('0.2 密码登录拿到 access_token', r.status === 200 && !!r.json?.access_token, `${r.status} ${r.text.slice(0, 160)}`)
    token = r.json?.access_token
  }

  let r = await api('GET', '/rest/v1/cards?select=*', { headers: userHeaders() })
  if (reuseToken) {
    check('0.3 复用会话可用：库里已有 GUI 提交的 20 张卡',
      r.status === 200 && Array.isArray(r.json) && r.json.length === 20,
      `${r.status} count=${Array.isArray(r.json) ? r.json.length : '?'}`)
  } else {
    check('0.3 新用户空库（RLS 只见自己的行）', r.status === 200 && Array.isArray(r.json) && r.json.length === 0, `${r.status}`)
  }

  // ── PHASE 1：A 模式才由脚本导入；B 模式数据已由 GUI 提交，直接校验落库值 ──────
  console.log('\n[1] 导入 20 条 + 落库校验（import_my_cards RPC）')
  if (!reuseToken) {
    r = await api('POST', '/rest/v1/rpc/import_my_cards', { headers: userHeaders(), body: { p_rows: payload } })
    check('S-13 返回 setof cards：200 + 全量行数组（20 行）', r.status === 200 && Array.isArray(r.json) && r.json.length === 20,
      `${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`)
  } else {
    check('S-13 GUI 提交链路落库：GET 返回 20 行（页面已展示成功提示）', r.status === 200 && r.json.length === 20)
  }
  const cards = await api('GET', '/rest/v1/cards?select=*', { headers: userHeaders() })
  const cardRows = Array.isArray(cards.json) ? cards.json : []
  const byName = Object.fromEntries(cardRows.map((c) => [c.name, c]))

  const dflt = byName['只有名字的默认卡']
  check('S-11a 只带卡名行物化默认：起始=DB今天，DDL=DB今天+2年，续费=关',
    dflt?.start_date === dbToday && dflt?.end_date === addYearsClamped(dbToday, 2) && dflt?.auto_renew === false,
    JSON.stringify({ s: dflt?.start_date, e: dflt?.end_date, ar: dflt?.auto_renew }))
  check('S-11b 缺终止日期的次卡 → DDL 物化 = DB今天+2年（与起始日无关 4-B5）',
    byName['满次体验30次卡']?.end_date === addYearsClamped(dbToday, 2),
    byName['满次体验30次卡']?.end_date)
  check('S-05b 显式值保留：配置A下端点卡 start=2024-09-06、配置B上端点卡 end=2028-09-06',
    byName['配置A下端点卡']?.start_date === '2024-09-06' && byName['配置B上端点卡']?.end_date === '2028-09-06')
  const renewNames = ['连续包周卡', '连续包月卡', '连续包季卡', '连续包年卡', '合同45天卡', '合同7天次卡', '月度团课30次续费卡', '全字段演示卡']
  check('S-08a 续费 8 行落库扣款日全部 = 各自终止日期',
    renewNames.every((n) => byName[n]?.auto_renew === true && byName[n]?.next_billing_date === byName[n]?.end_date),
    JSON.stringify(renewNames.map((n) => [n, byName[n]?.next_billing_date, byName[n]?.end_date])))
  check('S-08b 全字段演示卡：行内扣款日 2026-10-01 被忽略 → 落 2026-10-06',
    byName['全字段演示卡']?.next_billing_date === '2026-10-06', byName['全字段演示卡']?.next_billing_date)
  check('S-11c 合同45天卡：period_days=45、billing_cycle=null、扣款日=2026-10-20',
    byName['合同45天卡']?.period_days === 45 && byName['合同45天卡']?.billing_cycle === null &&
    byName['合同45天卡']?.next_billing_date === '2026-10-20')
  check('C-07 SQL 侧 insert_expired 留档：已结束历史留档卡 end=2026-08-31 落库',
    byName['已结束历史留档卡']?.end_date === '2026-08-31')

  // ── PHASE 2：幂等回贴（X-02 / S-04） ───────────────────────────────────────
  console.log('\n[2] 幂等回贴（同载荷再导一次）')
  const getCardsByName = async () => {
    const g = await api('GET', '/rest/v1/cards?select=*', { headers: userHeaders() })
    return Object.fromEntries((Array.isArray(g.json) ? g.json : []).map((c) => [c.name, c]))
  }
  const beforeByName = await getCardsByName()
  r = await api('POST', '/rest/v1/rpc/import_my_cards', { headers: userHeaders(), body: { p_rows: payload } })
  check('X-02a 回贴 200 + 仍返回 20 行（全部走更新分支）', r.status === 200 && Array.isArray(r.json) && r.json.length === 20)
  const afterByName = await getCardsByName()
  check('X-02b 回贴后业务字段零变化（抽查 年费会员卡/连续包月卡/双下界次卡）',
    afterByName['年费会员卡']?.end_date === '2027-09-05' &&
    afterByName['连续包月卡']?.billing_cycle === 'month' && afterByName['连续包月卡']?.next_billing_date === '2026-10-06' &&
    afterByName['双下界次卡']?.remaining_sessions === 1)
  check('S-04 skip_expired 是无操作：已结束历史留档卡 updated_at 不变（其余行 updated_at 前进）',
    beforeByName['已结束历史留档卡']?.updated_at === afterByName['已结束历史留档卡']?.updated_at &&
    beforeByName['年费会员卡']?.updated_at !== afterByName['年费会员卡']?.updated_at,
    JSON.stringify({ skip: [beforeByName['已结束历史留档卡']?.updated_at, afterByName['已结束历史留档卡']?.updated_at] }))

  // ── PHASE 3：部分行 SQL 语义（S-05 coalesce / S-06 门控 / S-07 互斥清洗 / S-09） ──
  console.log('\n[3] 部分行语义（直调 RPC 对账）')
  const rpcImport = async (rows) => api('POST', '/rest/v1/rpc/import_my_cards', { headers: userHeaders(), body: { p_rows: rows } })
  const cardByName = async () => {
    const g = await api('GET', '/rest/v1/cards?select=*', { headers: userHeaders() })
    return Object.fromEntries((Array.isArray(g.json) ? g.json : []).map((c) => [c.name, c]))
  }

  r = await rpcImport([{ name: '年费会员卡', remaining_sessions: 5 }])
  let cur = await cardByName()
  check('S-05 更新行缺字段保留现值：只写 remaining=5，起止/续费不变',
    r.status === 200 && cur['年费会员卡']?.remaining_sessions === 5 &&
    cur['年费会员卡']?.end_date === '2027-09-05' && cur['年费会员卡']?.start_date === '2026-09-06',
    JSON.stringify({ st: r.status, row: cur['年费会员卡'] }))

  r = await rpcImport([{ name: '只有名字的默认卡', remaining_sessions: 9 }])
  cur = await cardByName()
  check('S-06 次数能力未开（v_count_on）→ 更新行次数字段不写',
    r.status === 200 && cur['只有名字的默认卡']?.remaining_sessions === null,
    JSON.stringify(cur['只有名字的默认卡']?.remaining_sessions))

  r = await rpcImport([{ name: '连续包月卡', period_days: 30 }])
  cur = await cardByName()
  check('S-07 互斥清洗：写 period_days=30 → billing_cycle 机械置空；S-08 续费开扣款日仍=终止日期',
    r.status === 200 && cur['连续包月卡']?.period_days === 30 && cur['连续包月卡']?.billing_cycle === null &&
    cur['连续包月卡']?.next_billing_date === '2026-10-06',
    JSON.stringify({ st: r.status, row: cur['连续包月卡'] }))
  r = await rpcImport([{ name: '连续包月卡', billing_cycle: 'month' }])
  cur = await cardByName()
  check('S-07b 反向清洗：写回 billing_cycle → period_days 置空',
    r.status === 200 && cur['连续包月卡']?.billing_cycle === 'month' && cur['连续包月卡']?.period_days === null)

  r = await rpcImport([{ name: '连续包年卡', auto_renew: false }])
  cur = await cardByName()
  check('S-09 翻转续费关：扣款字段保留（4-B20），nbd 仍 2027-09-06',
    r.status === 200 && cur['连续包年卡']?.auto_renew === false && cur['连续包年卡']?.next_billing_date === '2027-09-06',
    JSON.stringify({ st: r.status, row: cur['连续包年卡'] }))
  r = await rpcImport([{ name: '连续包年卡', auto_renew: true, billing_cycle: 'year' }])
  cur = await cardByName()
  check('S-08c 翻转续费开：扣款日强制 = 生效 DDL 2027-09-06',
    r.status === 200 && cur['连续包年卡']?.auto_renew === true && cur['连续包年卡']?.next_billing_date === '2027-09-06')

  // ── PHASE 4：S-12 muted='cycle' 自动解除触发器 ─────────────────────────────
  console.log('\n[4] muted 自动解除触发器（cards_muted_reset）')
  const yueka = cur['连续包月卡']
  r = await api('PATCH', `/rest/v1/cards?id=eq.${yueka.id}`, {
    headers: { ...userHeaders(), Prefer: 'return=minimal' },
    body: { muted: 'cycle' },
  })
  check('S-12a PATCH 置 muted=cycle 成功', r.status === 204, `${r.status}`)

  r = await rpcImport(payload) // 同值例行写（end_date 不变）
  cur = await cardByName()
  check('S-12b end_date 同值重写不触发解除 → muted 保持 cycle',
    r.status === 200 && cur['连续包月卡']?.muted === 'cycle', cur['连续包月卡']?.muted)

  r = await rpcImport([{ name: '连续包月卡', auto_renew: true, billing_cycle: 'month', end_date: '2026-10-07' }])
  cur = await cardByName()
  check('S-12c end_date 实际变化 → muted 自动解除为 none',
    r.status === 200 && cur['连续包月卡']?.muted === 'none' && cur['连续包月卡']?.end_date === '2026-10-07',
    JSON.stringify({ st: r.status, muted: cur['连续包月卡']?.muted }))

  // ── PHASE 5：错误分支与整批回滚（S-01/S-02/S-03/S-10） ─────────────────────
  console.log('\n[5] 错误分支与整批回滚')
  r = await api('POST', '/rest/v1/rpc/import_my_cards', { headers: userHeaders(), body: { p_rows: { x: 1 } } })
  check('S-01 载荷非数组 → exception「必须是行数组」',
    r.status >= 400 && r.json?.message?.includes('必须是行数组'), `${r.status} ${r.json?.message}`)
  r = await api('POST', '/rest/v1/rpc/import_my_cards', { headers: userHeaders(), body: { p_rows: [{}] } })
  check('S-02 缺卡名 → exception「导入行缺少卡名」',
    r.status >= 400 && r.json?.message?.includes('导入行缺少卡名'), `${r.status} ${r.json?.message}`)
  r = await rpcImport([
    { name: '回滚验证卡', start_date: '2026-09-06' },
    { name: '回滚验证卡2', billing_cycle: 'month', period_days: 30 },
  ])
  cur = await cardByName()
  check('S-03 周期互斥 exception → 整批回滚（行数仍 20，无「回滚验证卡」）',
    r.status >= 400 && r.json?.message?.includes('二选一') && Object.keys(cur).length === 20 && !cur['回滚验证卡'],
    `${r.status} ${r.json?.message} count=${Object.keys(cur).length}`)
  r = await rpcImport([{ name: '续费无周期卡', auto_renew: true }])
  cur = await cardByName()
  check('S-10 续费开缺周期/天数 → DB CHECK cards_renew_complete 拒绝（防御兜底），行数仍 20',
    r.status >= 400 && r.json?.message?.includes('cards_renew_complete') && Object.keys(cur).length === 20,
    `${r.status} ${r.json?.message}`)
} finally {
  // ── PHASE 6：清理（删用户 → cards 级联删除；旧 token 失效） ──────────────────
  console.log('\n[6] 清理')
  if (userId) {
    const del = await api('DELETE', `/auth/v1/admin/users/${userId}`, { headers: adminHeaders })
    check('6.1 删除一次性用户 → 204', del.status === 204 || del.status === 200, `${del.status}`)
    if (token) {
      const after = await api('GET', '/rest/v1/cards?select=*', { headers: userHeaders() })
      // access token 是无状态 JWT，PostgREST 可能仍验签通过——但行已随用户级联删除，
      // 无论 401 还是空数组都证明"测试数据已清除"
      check('6.2 测试数据随用户级联清除（401 或空数组）',
        after.status === 401 || (after.status === 200 && Array.isArray(after.json) && after.json.length === 0),
        `${after.status}`)
    }
  } else {
    console.log('（未走到建户，无需清理）')
  }
}

console.log('')
if (failed > 0) {
  console.log(`${failed} 个断言失败`)
  process.exit(1)
}
console.log('SQL 侧端到端全部断言通过 ✓（S-01…S-13 / S-04 skip / S-12 触发器 / 整批回滚 / 清理）')
