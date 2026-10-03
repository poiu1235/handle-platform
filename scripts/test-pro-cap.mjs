// 容量墙的离线判据（PRD v3 3.4／3.5／7.4／7.5 第 15 条；D-14／D-19）。
// 用法：npm run test:cap
//
// 两层：
//   ① **驱动真 handler**（notes / balances / cards 三个 POST + 两个 import），
//      这样"接没接墙"不是我看代码说了算——没接，409 就不会出现，格子就红。
//      （/api/** 的验签在 _middleware 里，直接调 handler 时 data.user 由本文件注入，
//        所以这里不需要签 JWT；需要真验签的是 test-unbind 那种 /auth/ 端点。）
//   ② 静态门：入口清单、"不写第二处比较逻辑"、D-14 不加锁、两个 [id].js 刻意不接。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const imp = (p) => import(pathToFileURL(path.join(root, p)).href)
const notes = await imp('functions/api/notes.js')
const balances = await imp('functions/api/balances.js')
const cards = await imp('functions/api/cards.js')
const balImport = await imp('functions/api/balances/import.js')
const cardImport = await imp('functions/api/cards/import.js')
const { capMessage } = await imp('functions/_lib/proCap.js')

const BASE = 'https://fake.supabase.co'
const USER = 'uu-1'
const OPENID = 'oCap123'

let calls = []
let sc = {}
const reset = (over = {}) => {
  calls = []
  sc = {
    walls: true, covered: false, rpcFail: false,
    existing: { notes: 0, balances: 0, cards: 0 },
    keys: { balances: [], cards: [] },
    eqHits: [],
    ...over,
  }
}
const mkRes = (body, status = 200, headers = {}) => ({
  ok: status < 300, status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  json: async () => body,
})
globalThis.fetch = async (url, options = {}) => {
  const u = String(url)
  const method = options.method || 'GET'
  calls.push({ u, method, body: options.body ? JSON.parse(options.body) : null, headers: options.headers })
  if (u.includes('/rest/v1/rpc/pro_coverage')) {
    if (sc.rpcFail) return mkRes({ message: 'boom' }, 503)
    return mkRes({ is_covered: sc.covered, valid_until: sc.covered ? '2099-01-01T15:59:59Z' : null, remaining_days: sc.covered ? 30 : null })
  }
  if (u.includes('/rest/v1/user_identities')) return mkRes([{ openid: OPENID }])
  const t = ['notes', 'balances', 'cards'].find((x) => u.includes(`/rest/v1/${x}`))
  if (t) {
    const n = sc.existing[t]
    if (method === 'HEAD') return mkRes(null, 200, { 'content-range': n === null ? '' : `0-0/${n}` })
    if (method === 'GET') {
      // 临界那次 dedupe 查询形如 ?select=id&...&app_name=eq.X&limit=1 —— 桩要能回答
      // "这条到底存不存在"，否则 4.1 那格测的是桩不是代码（第一版就是这么假红的）。
      const eqm = u.match(/[?&](app_name|name)=eq\.([^&]+)/)
      if (eqm) return mkRes(sc.eqHits.includes(decodeURIComponent(eqm[2])) ? [{ id: 'hit' }] : [])
      const col = u.includes('select=app_name') ? 'app_name' : u.includes('select=name') ? 'name' : null
      const range = n === null ? '' : `0-${Math.max(n - 1, 0)}/${n}`
      return mkRes(col ? (sc.keys[t] || []).map((k) => ({ [col]: k })) : [], 200, { 'content-range': range })
    }
    if (method === 'DELETE') return mkRes([])
    return mkRes([{ id: 'new' }], 201)
  }
  if (u.includes('/rest/v1/rpc/import_my_cards')) return mkRes({ inserted: 0, updated: 0, skipped: 0 })
  throw new Error('未预期的出网目标：' + u)
}

const env = (walls = true) => ({
  SUPABASE_URL: BASE, SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc',
  PRO_WALLS_ENABLED: walls ? 'true' : 'false', PRO_PURCHASE_ENABLED: 'false', PRO_ENV: '0',
})
const ctx = (body, { walls = true, email = 'user@example.com' } = {}) => ({
  env: env(walls),
  data: { user: { id: USER, email }, accessToken: 'tok' },
  request: new Request(`${BASE}/api/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  waitUntil: () => {},
})
const post = async (handler, body, opts) => {
  const res = await handler(ctx(body, opts))
  return { status: res.status, data: await res.json().catch(() => null) }
}
const noteBody = (content = '一条便利贴') => ({ kind: 'idea', content, today: '2026-10-04' })
const balBody = (app_name = '新余额') => ({ app_name, amount: 12.5 })
const cardBody = (name = '新卡') => ({ name, start_date: '2026-10-01', end_date: '2027-10-01' })

const results = []
const check = (name, got, want) => results.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want })
const has = (s, sub) => String(s).includes(sub)

// ── 1. 关态四格（8.3：关态＝现网行为，两页形态相反 ⇒ 必须分别实测）─────────
reset({ walls: false, existing: { notes: 500, balances: 0, cards: 0 } })
let r = await post(notes.onRequestPost, noteBody(), { walls: false })
check('1.1 关态便利贴仍是现网 500 且在拦', r.status, 409)
check('1.2 关态文案逐字不变（症状要能逐字比对）', r.data?.error, '便利贴已到上限（500 条），先清理一些吧')
reset({ walls: false, existing: { notes: 499, balances: 0, cards: 0 } })
check('1.3 关态便利贴 499 条仍可记', (await post(notes.onRequestPost, noteBody(), { walls: false })).status, 201)
reset({ walls: false, existing: { notes: 0, balances: 9999, cards: 9999 } })
check('1.4 关态余额**没有墙**（现网如此，不是 50）', (await post(balances.onRequestPost, balBody(), { walls: false })).status, 201)
check('1.5 关态会员卡**没有墙**', (await post(cards.onRequestPost, cardBody(), { walls: false })).status, 201)
check('1.6 关态不去问判定（零额外请求）', calls.filter((c) => c.u.includes('rpc/pro_coverage')).length, 0)

// ── 2. 墙开着：免费档 200／50／50，会员档 500／100／100 ──────────────────
reset({ existing: { notes: 200, balances: 0, cards: 0 } })
r = await post(notes.onRequestPost, noteBody(), {})
check('2.1 免费档便利贴 200 拦', [r.status, has(r.data?.error, '便利贴 200 条上限')], [409, true])
reset({ existing: { notes: 199, balances: 0, cards: 0 } })
check('2.2 第 200 条仍可记', (await post(notes.onRequestPost, noteBody(), {})).status, 201)
reset({ existing: { notes: 0, balances: 50, cards: 0 } })
check('2.3 免费档余额 50 拦', (await post(balances.onRequestPost, balBody(), {})).status, 409)
reset({ existing: { notes: 0, balances: 0, cards: 50 } })
check('2.4 免费档会员卡 50 拦', (await post(cards.onRequestPost, cardBody(), {})).status, 409)
reset({ covered: true, existing: { notes: 200, balances: 50, cards: 50 } })
check('2.5 会员档同样存量全部放行', [
  (await post(notes.onRequestPost, noteBody(), {})).status,
  (await post(balances.onRequestPost, balBody(), {})).status,
  (await post(cards.onRequestPost, cardBody(), {})).status,
], [201, 201, 201])
reset({ covered: true, existing: { notes: 500, balances: 100, cards: 100 } })
check('2.6 会员档撞自己的上限', [
  (await post(notes.onRequestPost, noteBody(), {})).status,
  (await post(balances.onRequestPost, balBody(), {})).status,
], [409, 409])

// ── 3. 文案四约束（D-19 两支 + 3.5 + 7.4）────────────────────────────────
reset({ existing: { notes: 200, balances: 0, cards: 0 } })
const guestMsg = (await post(notes.onRequestPost, noteBody(), { email: 'g@guest.invalid' })).data?.error
// 🔴 D-19 禁的是"给访客一条他当下做不到的指引"（如"也可在网页版导出"），
//    而"绑定邮箱后可在网页版导出备份"是**既有能力**、明文允许带（正本 7.5 第 15 条访客那一格）。
//    第一版断言写成"不含'网页版'"，把被允许的那半句也判成违规——判据过宽会逼实现删掉正确文案。
check('3.1 访客看不到"也可在网页版导出"这条当下做不到的指引', has(guestMsg, '也可在网页版导出'), false)
check('3.1b 访客那支也不含"全部数据"', has(guestMsg, '全部数据'), false)
check('3.2 访客可看到"绑定邮箱后可导出备份"（既有能力，不是付费路径）', has(guestMsg, '绑定邮箱后可在网页版导出备份'), true)
reset({ existing: { notes: 200, balances: 0, cards: 0 } })
const mailMsg = (await post(notes.onRequestPost, noteBody(), {})).data?.error
check('3.3 已绑邮箱的便利贴提到网页版导出', has(mailMsg, '网页版导出便利贴'), true)
check('3.4 但不许说"全部数据"（余额/卡导出还没做＝D-19 丙未落地）', has(mailMsg, '全部数据'), false)
reset({ existing: { notes: 0, balances: 50, cards: 0 } })
const balMsg = (await post(balances.onRequestPost, balBody(), {})).data?.error
check('3.5 余额域不提导出（该域没有导出功能）', has(balMsg, '导出'), false)
reset({ existing: { notes: 260, balances: 0, cards: 0 } })
const overMsg = (await post(notes.onRequestPost, noteBody(), {})).data?.error
check('3.6 存量已超 ⇒ 写"已超出 60 条"', has(overMsg, '已超出 60 条'), true)
check('3.7 且不出现负数余量', has(overMsg, '-60'), false)
check('3.8 超存量仍说清"已有的可查看/删除"（3.5 不是锁门）', has(overMsg, '仍可正常查看和删除'), true)
const allMsgs = [guestMsg, mailMsg, balMsg, overMsg, capMessage({ domain: 'cards', cap: 50, existing: 50, guest: false, legacy: false })]
check('3.9 没有任何一支写成"硬上限/最多/续费后使用"', allMsgs.some((m) => /硬上限|最多|续费后|过期，请/.test(String(m))), false)
reset({ covered: true, existing: { notes: 500, balances: 0, cards: 0 } })
const memMsg = (await post(notes.onRequestPost, noteBody(), {})).data?.error
check('3.10 会员档撞墙不再提"开通会员"（提了就是假话）', has(memMsg, '开通会员'), false)

// ── 4. upsert 覆盖不增行 ⇒ 临界也不能拦（一.5 记录动作免费）──────────────
reset({ existing: { notes: 0, balances: 50, cards: 50 }, eqHits: ['新余额'] })
check('4.1 余额同名覆盖 ⇒ 放行', (await post(balances.onRequestPost, balBody('新余额'), {})).status, 201)
reset({ existing: { notes: 0, balances: 50, cards: 50 }, eqHits: [] })
check('4.2 同名不存在（＝真新增）⇒ 拦', (await post(balances.onRequestPost, balBody('新余额'), {})).status, 409)
reset({ existing: { notes: 0, balances: 50, cards: 50 }, eqHits: ['别的卡'] })
check('4.3 卡名不同 ⇒ 拦', (await post(cards.onRequestPost, cardBody('新卡'), {})).status, 409)
reset({ existing: { notes: 0, balances: 10, cards: 10 }, eqHits: [] })
await post(balances.onRequestPost, balBody('x'), {})
check('4.4 非临界时零 dedupe 查询（成本只在临界发生）', calls.filter((c) => c.method === 'GET' && /app_name=eq\./.test(c.u)).length, 0)

// ── 5. 批量导入：整批预检、超出整批不导、告知还能导几条 ────────────────────
//   免费档余额 50：已有 48 + 本次 3 条新增 ⇒ 51 > 50 ⇒ 拦，余量 2 条
//   （第一版这里我写的是 45+3=48 却期望被拦——算错的是测试，不是代码。）
reset({ existing: { notes: 0, balances: 48, cards: 0 } })
r = await post(balImport.onRequestPost, { rows: [balBody('A'), balBody('B'), balBody('C')] }, {})
check('5.1 导入超额 ⇒ 整批 409', r.status, 409)
check('5.2 文案给出"还能导入 2 条"', has(r.data?.error, '还能导入 2 条'), true)
check('5.3 且明写整批未导入', has(r.data?.error, '整批未导入'), true)
check('5.4 Web 侧指路指向真实存在的收款处（小程序），不是"绑邮箱即可开通"', has(r.data?.error, '在手机微信里打开 Handle 小程序'), true)
reset({ existing: { notes: 0, balances: 49, cards: 0 } })
check('5.5 批内同名只算一行 ⇒ 49+1 放行', (await post(balImport.onRequestPost, { rows: [balBody('A'), balBody('A')] }, {})).status, 201)
reset({ existing: { notes: 0, balances: 49, cards: 0 } })
check('5.6 批内两个不同名 ⇒ 49+2 拦', (await post(balImport.onRequestPost, { rows: [balBody('A'), balBody('B')] }, {})).status, 409)
reset({ existing: { notes: 0, balances: 0, cards: 49 } })
check('5.7 卡导入同样接墙（拦在 RPC 之前）', (await post(cardImport.onRequestPost, { rows: [cardBody('新甲'), cardBody('新乙')] }, {})).status, 409)
check('5.8 拦下时不碰 import_my_cards', calls.some((c) => c.u.includes('import_my_cards')), false)
reset({ walls: false, existing: { notes: 0, balances: 9999, cards: 9999 } })
r = await post(balImport.onRequestPost, { rows: [balBody('A')] }, { walls: false })
check('5.7 关态批量放行且不查 key 集合', [r.status, calls.filter((c) => c.method === 'GET').length], [201, 0])

// ── 6. 查不清就放行（7.2 写路径），且留可 grep 的日志 ─────────────────────
reset({ rpcFail: true, existing: { notes: 500, balances: 50, cards: 50 } })
const logs = []
const realErr = console.error
console.error = (...a) => logs.push(a.join(' '))
r = await post(balances.onRequestPost, balBody(), {})
console.error = realErr
check('6.1 判定查询失败 ⇒ 放行（不因一次瞬时错误把记录拦在门外）', r.status, 201)
check('6.2 留了 pro-cap-lookup-failed', logs.some((l) => l.includes('pro-cap-lookup-failed')), true)
reset({ existing: { notes: null, balances: null, cards: null } })
check('6.3 数不出来（NaN）⇒ 放行，沿用现网语义', (await post(notes.onRequestPost, noteBody(), {})).status, 201)

// ── 7. 静态门 ─────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}
const rel = (f) => path.relative(root, f).replace(/\\/g, '/')
const fnFiles = walk(path.join(root, 'functions'))
const src = new Map(fnFiles.map((f) => [f, readFileSync(f, 'utf8')]))

const WIRED = ['functions/api/notes.js', 'functions/api/balances.js', 'functions/api/cards.js', 'functions/api/balances/import.js', 'functions/api/cards/import.js']
check('7.1 五个新增路径全部接墙（判墙只写一处）', WIRED.filter((f) => !src.get(path.join(root, f)).includes('proCap.js')), [])
const writers = fnFiles.filter((f) => /rest\/v1\/(notes|balances|cards)\b/.test(src.get(f)) && /method:\s*'POST'/.test(src.get(f))).map(rel)
check('7.2 所有 POST 进这三张表的端点都在接墙清单里', writers.filter((f) => !WIRED.includes(f) && !f.includes('_lib/')), [])
// 🔴 着力点＝"端点只许**调** enforce\*，不许自己碰 CAPS／capMessage／跟 cap 比较"。
//    （第一版把 `enforceCapacity(` 也算进违规——那正是要求它们做的事，判据反了。）
const secondImpl = fnFiles.filter((f) => rel(f).startsWith('functions/api/') && /CAPS\.|capMessage\(|>=\s*cap|>\s*cap\b/.test(src.get(f))).map(rel)
check('7.3 端点里没有第二处判墙实现', secondImpl, [])
check('7.4 D-14＝不加锁：functions/ 里不出现 advisory lock', fnFiles.filter((f) => /advisory/i.test(src.get(f))).map(rel), [])
check('7.5 档位数值只在 _lib 两个模块里（3.3 一处来源）', fnFiles.filter((f) => /CAPS\s*=|CAPS\./.test(src.get(f)) && !f.includes(`${path.sep}_lib`)).map(rel), [])
// 🔴 E-11 登记：PRD 3.4 列了七个写入口，但 balances/[id].js 与 cards/[id].js 只有
//    PATCH/DELETE——**不新增行**，给它们接墙反而违反 3.5「绝不为腾位动存量」。
//    所以实际接墙的是 5 个新增路径。这条判据把"少两个"钉成有记录的取舍，不是漏接。
const idFiles = ['functions/api/balances/[id].js', 'functions/api/cards/[id].js']
check('7.6 两个 [id].js 刻意不接墙（PATCH/DELETE 不增行，E-11）', idFiles.filter((f) => src.get(path.join(root, f)).includes('proCap.js')), [])

// ── 输出 ───────────────────────────────────────────────────────────────────
let fails = 0
for (const x of results) {
  if (!x.ok) fails++
  console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : `\n        期望 ${JSON.stringify(x.want)}\n        现值 ${JSON.stringify(x.got)}`}`)
}
console.log(`\n共 ${results.length} 格，FAIL ${fails} 格`)
process.exit(fails === 0 ? 0 : 1)
