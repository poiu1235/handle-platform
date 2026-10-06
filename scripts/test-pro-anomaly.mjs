// B5① `anomaly` 单出边的离线判据：跑**真源码** `functions/admin/pro-anomaly.js`
// （fetch 打桩成假 Supabase + 假 token + 假 query_order）。用法：npm run test:anomaly
//
// 这一支是全仓**唯一能把"钱与货对不上"的单子推到终态**的地方，所以这张表判的只有一句话：
// 🔴 **没有平台的一句答复，任何终态都不许写进库**。三种收口（credit／refunded／closed）
// 各自对应一种平台答复，答错方向就不许改——因为三种失败里两种是静默的：
//   · 把其实还付着钱的单标成 refunded/closed ⇒ 权益没了、订单说没事，A3 从此不再显示它；
//   · 给其实没付过的单写账本 ⇒ 凭空发权益（那是 7.6"永不允许手工发权益"那条铁律的正例）。
// 其余格子判的是**写序**（refunded 先撤权益后改状态）、**CAS 匹配 0 行不许顶成 200**、
// 以及 E-19 那一格遗留单（`paid_at` 为空 ⇒ 库侧 CHECK 会拒 refunded，只能按平台时刻回填）。
//
// ⚠️ 它证明不了的：`in.(…)`／`is.null` 在真 PostgREST 上到底匹配几行（那是 `pro-billing-schema-check.sql`
//   与真机的活）；`query_order` 的回包形状（R-9 ⑲ 已对已付与已退各取过一次真单，见正本附录甲）；
//   以及 🔴 这一支**从没在现网跑过**——第一次真用就是拿它收 E-19 那笔遗留单（验收 #74）。
//
// 🔴 两类反证都做过，结果记在文件末尾（不写"跑过了"，写第几格红、为什么只红它该红的）。
import path from 'node:path'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { pickToSelect, readsRowFieldsOf, selectColsOf } from './_lib/producerShape.mjs'

const root = path.resolve(import.meta.dirname, '..')
const results = []
const check = (name, got, want) => results.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want })

const { onRequestPost } = await import(pathToFileURL(path.join(root, 'functions/admin/pro-anomaly.js')).href)

const OID = '11111111-1111-4111-8111-111111111111'
const NO = 'T17911411665627c4f6928' // 🔴 就是 E-19 那笔遗留单号：判据用真单号的形状，不写 'T-1'
const OPENID = 'ob9w-3fSO7EjTCQTM2JyHacr2RsU'
const UID = 'u-guest-1'
// `paid_time` 是 unix **秒**（附录甲，两轮真单各证一次）。期望值刻意写成字面 ISO：
// 在判据里重算一遍 ×1000 就是"跟着被测代码一起错"（E-19 那两格判据的原罪）。
const PAID_SEC = 1791141176
const PAID_ISO = '2026-10-04T19:12:56.000Z'
// 月卡 30 天是**政策值**（在 `proCatalog` 里），同样写字面值：把常量 import 进来的话，
// 有人把 30 改成 31 时这张表一格都不会红（R3 那道没牙的门，同一族）。
const DURATION_MONTHLY = 30

const anomalyRow = (over = {}) => ({
  id: OID,
  user_id: UID,
  provider: 'wechat_mp',
  payer_openid: OPENID,
  out_trade_no: NO,
  product_id: 'monthly_mem_android',
  goods_price: 1,
  currency_type: 'CNY',
  env: 0,
  buy_quantity: 1,
  status: 'anomaly',
  anomaly_reason: 'refunded_not_credited',
  paid_at: PAID_ISO,
  wx_order_id: 'VPO-1',
  wxpay_order_id: null,
  created_at: '2026-10-04T19:12:47.000Z',
  expires_at: '2026-10-04T19:27:47.000Z',
  note: '主动查单回"平台已退款"而我方未入账；旧单标异常后放行新单（E-17 判丙）',
  ...over,
})

// ── 假后端（🔴 会随写入变状态：不反映写后的行＝`creditOrder` 读到的还是写前的那一行，
//   于是"交还给入账"这一整族测的都是假形状，4.1 第一版就是这么红的）────────────
let calls = []
let S = {}
const Q_PAID = { status: 3, paid_time: PAID_SEC, paid_fee: 1, wx_order_id: 'VPO-1' }
const Q_REFUNDED = { status: 5, paid_time: PAID_SEC, paid_fee: 1, refund_info: { refund_order: ['VPR26100503079104810'] } }
const Q_UNPAID = { status: 1, paid_time: 0, paid_fee: 0 }
const Q_CLOSED = { status: 6, paid_time: 0, paid_fee: 0 }
const defaultStub = () => ({
  row: anomalyRow(),
  orderRows: null, // 非 null 时直接当 GET 的结果（空数组＝库里没这单）
  orderReadStatus: 200,
  patchRows: undefined, // undefined＝按 body 合并进 S.row 并回它；[]＝CAS 没匹配到
  patchStatus: 200,
  ledgerLive: [],
  ledgerReadStatus: 200,
  ledgerPatchRows: undefined, // undefined＝按 revoked_at 增减 S.ledgerLive
  ledgerInsertStatus: 201,
  tokenBody: { access_token: 'TOKEN-x', expires_in: 7200 },
  tokenStatus: 200,
  queryBody: { errcode: 0, errmsg: 'ok', order: Q_REFUNDED },
  queryThrows: false,
  notifyBody: { errcode: 0, errmsg: 'ok' },
  coverageBody: { is_covered: false, valid_until: null, remaining_days: null },
})
const reset = (over = {}) => {
  calls = []
  S = { ...defaultStub(), ...over }
}
const withQuery = (order) => {
  S.queryBody = { errcode: 0, errmsg: 'ok', order }
}

/** 🔴 桩行按**真实 select** 裁（E-31 那一族：喂给端点的行比库里会回的多一列＝漏列测不出来） */
const selectOf = (u) => {
  const m = /[?&]select=([^&]*)/.exec(u)
  return m ? m[1].replace(/%22/g, '').replace(/[^a-z_,]/g, '').split(',').filter(Boolean) : null
}

globalThis.fetch = async (url, options) => {
  const u = String(url)
  const method = (options && options.method) || 'GET'
  const body = options && options.body ? JSON.parse(options.body) : null
  calls.push({ url: u, method, body })
  const mk = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
  if (u.includes('api.weixin.qq.com/cgi-bin/token')) {
    if (S.tokenStatus !== 200) return mk({ errcode: 40013, errmsg: 'invalid appid' }, S.tokenStatus)
    return mk(S.tokenBody)
  }
  if (u.includes('/xpay/query_order')) {
    if (S.queryThrows) throw new Error('socket hang up')
    return mk(S.queryBody)
  }
  if (u.includes('/xpay/notify_provide_goods')) return mk(S.notifyBody)
  if (u.includes('/rest/v1/rpc/pro_coverage')) return mk(S.coverageBody)
  if (u.includes('/rest/v1/pro_ledger') && method === 'POST') {
    if (S.ledgerInsertStatus !== 201) return mk({ code: '23505', message: 'duplicate key value violates unique constraint "pro_ledger_order_id_uk"' }, S.ledgerInsertStatus)
    S.ledgerLive = [{ id: 'l-1', order_id: body.order_id }] // 写成了＝下一读就有活权益（幂等格靠它）
    return mk({}, 201)
  }
  if (u.includes('/rest/v1/pro_ledger') && method === 'PATCH') {
    if (S.ledgerPatchRows !== undefined) return mk(S.ledgerPatchRows)
    const revoke = body && body.revoked_at !== null && body.revoked_at !== undefined
    // 🔴 桩要按**过滤条件**数行：`revoked_at=is.null` 时只有活着的行会被改到。写死"改到一行"
    //   会把"名下根本没有活权益"那一格报成 `revoked`（5.8 第一版就是这么假绿的）。
    const hit = revoke ? S.ledgerLive : []
    S.ledgerLive = revoke ? [] : S.ledgerLive
    return mk(hit.map((x, i) => ({ id: 'l-' + i })))
  }
  if (u.includes('/rest/v1/pro_ledger')) {
    if (S.ledgerReadStatus !== 200) return mk({ message: 'ledger read boom' }, S.ledgerReadStatus)
    return mk(S.ledgerLive)
  }
  if (u.includes('/rest/v1/pro_orders') && method === 'PATCH') {
    if (S.patchStatus !== 200) return mk({ message: 'patch boom' }, S.patchStatus)
    if (S.patchRows !== undefined) return mk(S.patchRows)
    S.row = { ...S.row, ...body }
    return mk([S.row])
  }
  if (u.includes('/rest/v1/pro_orders')) {
    if (S.orderReadStatus !== 200) return mk({ message: 'order read boom' }, S.orderReadStatus)
    if (S.orderRows !== null) return mk(S.orderRows)
    if (!S.row) return mk([])
    const cols = selectOf(u)
    return mk([cols ? pickToSelect(cols, S.row) : S.row])
  }
  throw new Error('未预期的出网目标：' + u)
}

const env = (over = {}) => ({
  SUPABASE_URL: 'https://fake',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  PRO_ADMIN_TOKEN: 'adm-secret',
  PRO_ENV: '0',
  WX_APPID: 'wx1',
  WX_SECRET: 'sec1',
  WX_PAY_APPKEY_PROD: 'appkey-1',
  ...over,
})
const admin = async (body, headers = { 'x-admin-token': 'adm-secret' }, eover = {}) => {
  const res = await onRequestPost({
    request: {
      json: async () => body,
      headers: { get: (k) => (String(k).toLowerCase() === 'x-admin-token' ? headers['x-admin-token'] || null : null) },
    },
    env: env(eover),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const good = (over = {}) => ({ outTradeNo: NO, action: 'credit', operator: 'owner', note: '后台那一单已核对，按查单收口', ...over })

// 🔴 取"那一次调用"要给缺调用哨兵：被拒时根本没发出去，裸下标会抛 TypeError 把整张表崩掉
const MISSING = '‹没有那次调用›'
const bodyAt = (list, i = 0) => (list[i] ? list[i].body : MISSING)
const urlAt = (list, i = 0) => (list[i] ? list[i].url : MISSING)
const orderPatches = () => calls.filter((c) => c.url.includes('/rest/v1/pro_orders') && c.method === 'PATCH')
const ledgerPatches = () => calls.filter((c) => c.url.includes('/rest/v1/pro_ledger') && c.method === 'PATCH')
const ledgerPosts = () => calls.filter((c) => c.url.includes('/rest/v1/pro_ledger') && c.method === 'POST')
const queryCalls = () => calls.filter((c) => c.url.includes('/xpay/query_order'))
const notifyCalls = () => calls.filter((c) => c.url.includes('/xpay/notify_provide_goods'))
// ⚠️ "零写"只数**对库的** POST/PATCH：`/xpay/query_order` 与 `/rpc/pro_coverage` 都是 POST 却不写库
//   （计数口径按目标系统收窄，否则"零写"那族永远红得莫名其妙——B3-3 那一轮踩过）。
const writes = () => calls.filter((c) => c.url.includes('/rest/v1/') && !c.url.includes('/rpc/') && (c.method === 'POST' || c.method === 'PATCH'))
const firstIdx = (pred) => calls.findIndex(pred)

// ── 1. 两道门：凭证与留痕，都必须在**任何出网之前** ──────────────────────────
reset()
let r = await admin(good(), { 'x-admin-token': 'wrong' })
check('1.1 凭证不对 ⇒ 401 admin_unauthorized 且一次出网都没有', [r.status, r.body.code, calls.length], [401, 'admin_unauthorized', 0])

reset()
r = await admin(good(), { 'x-admin-token': '' })
check('1.2 不带凭证 ⇒ 同样 401（🔴 `/api/**` 那层的"未登录"401 不许被当成这一支的门——它本来就不在那条路上）', [r.status, r.body.code, calls.length], [401, 'admin_unauthorized', 0])

reset()
r = await admin(good(), { 'x-admin-token': 'whatever' }, { PRO_ADMIN_TOKEN: undefined })
check('1.3 没配 PRO_ADMIN_TOKEN ⇒ 503 admin_disabled，🔴 不许长得像"凭证不对"', [r.status, r.body.code, calls.length], [503, 'admin_disabled', 0])

reset()
r = await admin({ outTradeNo: NO, action: 'credit', operator: '', note: 'n' })
check('1.4 缺 operator ⇒ 400 admin_note_required 且零出网（pro_orders 侧没有 CHECK，这道门只有代码里这一份）', [r.status, r.body.code, calls.length], [400, 'admin_note_required', 0])

reset()
r = await admin({ outTradeNo: NO, action: 'credit', operator: 'owner', note: '   ' })
check('1.5 note 只有空白 ⇒ 400（🔴 不许变成库里一条"看着有、其实空"的留痕）', [r.status, r.body.code, calls.length], [400, 'admin_note_required', 0])

reset()
r = await admin({ outTradeNo: NO, action: 'refunf', operator: 'owner', note: 'n' })
check('1.6 action 拼错 ⇒ 400，🔴 不猜成 refunded', [r.status, r.body.code, calls.length], [400, 'bad_request', 0])

reset()
r = await admin({ outTradeNo: '  ', action: 'credit', operator: 'owner', note: 'n' })
check('1.7 缺单号 ⇒ 400 且零出网', [r.status, r.body.code, calls.length], [400, 'bad_request', 0])

reset()
{
  withQuery(Q_REFUNDED)
  const res = await admin({ outTradeNo: NO, action: 'refunded', operator: '  owner  ', note: '  后台那一单已核对  ' })
  check('1.8 operator/note 先 trim 再写（🔴 留痕那列不许带着一串空格进 A3，也不许"只传了空白"算填了）', [res.status, bodyAt(orderPatches()).operator], [200, 'owner'])
}

// ── 2. 哪些行有出边 ────────────────────────────────────────────────────────
reset()
S.row = null
r = await admin(good())
check('2.1 库里没这单 ⇒ 404 no_such_order 且零写', [r.status, r.body.code, writes().length], [404, 'no_such_order', 0])

for (const st of ['paid', 'refunded', 'closed']) {
  reset()
  S.row = anomalyRow({ status: st, anomaly_reason: null })
  const res = await admin(good())
  check(`2.2 ${st} 的单再收一次＝改历史 ⇒ 409 not_closable，🔴 连平台都不去问`, [res.status, res.body.code, res.body.now, writes().length, queryCalls().length], [409, 'not_closable', st, 0, 0])
}

reset()
S.row = anomalyRow({ status: 'pending', anomaly_reason: null, note: null, paid_at: null })
withQuery(Q_REFUNDED)
r = await admin(good({ action: 'refunded' }))
check('2.3 🔴 卡住的 pending（E-19 那笔遗留单的现状）也有出边 ⇒ 这一格过＝那笔单不必再靠手工 UPDATE', [r.status, r.body.from, r.body.status], [200, 'pending', 'refunded'])

reset()
S.row = anomalyRow({ payer_openid: null })
r = await admin(good())
check('2.4 没有 payer_openid ⇒ 409 no_payer_openid 且零写（问不了平台＝没有凭据，不许按管理员说的办）', [r.status, r.body.code, writes().length], [409, 'no_payer_openid', 0])

reset()
S.row = anomalyRow({ id: null })
r = await admin(good())
check('2.5 读不到主键 ⇒ 503 且零写（CAS 没有 WHERE 的对象）', [r.status, r.body.code, writes().length], [503, 'no_order_id', 0])

// ── 3. 三种收口各自的证据门（🔴 本端点真正的门）─────────────────────────────
// 每一格：[action, 平台答复, 归类, 该答复支持的收口]
const EVIDENCE_CASES = [
  ['credit', Q_PAID, 'paid', ['credit']],
  ['credit', Q_REFUNDED, 'refunded', ['refunded']],
  ['credit', Q_UNPAID, 'unpaid', ['closed']],
  ['credit', Q_CLOSED, 'closed', ['closed']],
  ['refunded', Q_PAID, 'paid', ['credit']],
  ['refunded', Q_REFUNDED, 'refunded', ['refunded']],
  ['refunded', Q_CLOSED, 'closed', ['closed']],
  ['closed', Q_PAID, 'paid', ['credit']],
  ['closed', Q_UNPAID, 'unpaid', ['closed']],
  ['closed', Q_REFUNDED, 'refunded', ['refunded']],
]
{
  const bad = []
  for (const [action, order, kind, supports] of EVIDENCE_CASES) {
    reset()
    withQuery(order)
    const res = await admin(good({ action }))
    const allowed = (action === 'credit' && kind === 'paid') || (action === 'refunded' && kind === 'refunded') || (action === 'closed' && (kind === 'unpaid' || kind === 'closed'))
    if (allowed) {
      if (res.status !== 200) bad.push(`${action}/${kind} ⇒ ${res.status} ${res.body && res.body.code}`)
      continue
    }
    if (!(res.status === 409 && res.body.code === 'evidence_mismatch' && res.body.platformSays === kind)) {
      bad.push(`拒 ${action}/${kind} 得到 ${res.status} ${res.body && res.body.code} ${res.body && res.body.platformSays}`)
    }
    if (writes().length) bad.push(`拒 ${action}/${kind} 却还是写了 ${writes().length} 次`)
    if (JSON.stringify(res.body.supportedActions) !== JSON.stringify(supports)) bad.push(`出路提示 ${action}/${kind} 得到 ${JSON.stringify(res.body.supportedActions)}`)
  }
  check('3.1 🔴 三种收口×四种平台答复：答错方向一律 409 evidence_mismatch 且零写（10 组全扫，红格会点名是哪一组）', bad, [])
  check('3.2 拒的时候要把出路说清：body 里回"这一答复支持哪些收口"（一个布尔塌两种相反状态＝给用户造死路）', EVIDENCE_CASES.map(([, , , s]) => s.join('/')).slice(1, 4), ['refunded', 'closed', 'closed'])
}
{
  reset()
  S.queryBody = { errcode: 268490002, errmsg: '数据不存在' }
  const res = await admin(good({ action: 'credit' }))
  check('3.3 查无此单（268490002）**是证据不是故障**：对 credit 是 409，但它支持 closed', [res.status, res.body.code, res.body.platformSays, res.body.supportedActions], [409, 'evidence_mismatch', 'not_found', ['closed']])
  reset()
  S.queryBody = { errcode: 268490002, errmsg: '数据不存在' }
  const res2 = await admin(good({ action: 'closed' }))
  check('3.4 同一答复给 closed ⇒ 合法收口（"平台查无此单"＝这单根本没付过）', [res2.status, res2.body.status, res2.body.ledgerMoved], [200, 'closed', 'none_live'])
}
{
  const bad = []
  const fails = [
    ['取 access_token 失败（appid 不对）', { tokenStatus: 400 }],
    ['平台回签名错', { queryBody: { errcode: 268490003, errmsg: '签名错误' } }],
    ['出网抛错（unreachable）', { queryThrows: true }],
    ['没见过的 status（7＝退款失败，文档也没背书过程态）', { queryBody: { errcode: 0, errmsg: 'ok', order: { status: 7, paid_time: PAID_SEC } } }],
    ['平台限频', { queryBody: { errcode: 268490015, errmsg: '频率限制' } }],
  ]
  for (const [label, over] of fails) {
    reset()
    S = { ...S, ...over }
    const res = await admin(good())
    if (!(res.status === 503 && res.body.code === 'query_unavailable' && writes().length === 0)) {
      bad.push(`${label} ⇒ ${res.status} ${res.body && res.body.code}，写了 ${writes().length} 次`)
    }
  }
  check('3.5 🔴 五种"问不到"（含没见过的 status 与限频）⇒ 全部 503 query_unavailable 且零写（"没查到"永远折不成"没付"或"已退"）', bad, [])
  reset()
  S.queryBody = { errcode: 0, errmsg: 'ok' }
  {
    const res = await admin(good())
    check('3.6 回包里没有 order 对象＝查无此单（not_found）⇒ 那是平台**答了话**，不是故障：409 且指路 closed', [res.status, res.body.code, res.body.platformSays, res.body.supportedActions], [409, 'evidence_mismatch', 'not_found', ['closed']])
  }
}

// ── 4. credit：改判成入账（交还给唯一那份入账实现，本端点不写 paid、不写账本行）──
reset()
withQuery(Q_PAID)
S.row = anomalyRow({ paid_at: null }) // E-19 现场的形状
r = await admin(good({ action: 'credit' }))
check('4.1 anomaly 单改判入账 ⇒ 200、outcome=credited、回读确认状态与权益都落地了', [r.status, r.body.outcome, r.body.status, r.body.coverageLive, r.body.verifyFailed], [200, 'credited', 'paid', true, false])
{
  const casIdx = firstIdx((c) => c.url.includes('/rest/v1/pro_orders') && c.method === 'PATCH')
  const ledIdx = firstIdx((c) => c.url.includes('/rest/v1/pro_ledger') && c.method === 'POST')
  check('4.2 🔴 写序＝先留痕 CAS（→pending）、后由入账实现写账本行', [casIdx >= 0, ledIdx > casIdx], [true, true])
  check('4.3 CAS 是带条件的：WHERE 同时钉主键与**我读到的那个状态**（并发时匹配 0 行，不覆盖别人）', [urlAt(orderPatches()).includes(`id=eq.${OID}`), urlAt(orderPatches()).includes('status=eq.anomaly')], [true, true])
  const b = bodyAt(orderPatches())
  check('4.4 CAS 写的三样：pending＋清掉 anomaly_reason＋留痕（🔴 不留痕的那次改判等于没发生）', [b.status, b.anomaly_reason, b.operator], ['pending', null, 'owner'])
  check('4.5 note 是**追加**：来路那句还在（"为什么进的 anomaly"不能被这次收口抹掉）', [String(b.note).includes('E-17 判丙'), String(b.note).includes('admin:credit by owner'), String(b.note).includes('status=3')], [true, true, true])
  const lp = bodyAt(ledgerPosts())
  check('4.6 账本行的四样全部来自**订单行与查单**，不是管理员传的（4.6：不接受调用方传金额/时长/openid）', [lp.order_id, lp.payer_openid, lp.effective_at, lp.duration_days], [OID, OPENID, PAID_ISO, DURATION_MONTHLY])
  check('4.7 🔴 发货告知跟着入账一起打一次（E-20① 那一步不是管理端另写的，频次门也照用）', notifyCalls().length, 1)
  check('4.8 查单两次：一次收口证据、一次入账本身（🔴 不是一句"管理员说了算"，也不是零次）', queryCalls().length, 2)
  check('4.9 paid_at 由入账实现按平台 paid_time 写（管理端这一支自己一个字都不写 paid_at）', [bodyAt(orderPatches(), 1).paid_at, bodyAt(orderPatches(), 1).status], [PAID_ISO, 'paid'])
}
{
  reset()
  withQuery(Q_PAID)
  S.ledgerLive = [{ id: 'l-1' }]
  S.ledgerInsertStatus = 409
  const res = await admin(good({ action: 'credit' }))
  check('4.10 E-19 那种"账本行写成了、订单还挂着"的单 ⇒ outcome=already、权益照旧活着（幂等收敛，不双发权益、不重复发货）', [res.status, res.body.outcome, res.body.coverageLive, notifyCalls().length], [200, 'already', true, 0])
}
{
  reset()
  withQuery(Q_PAID)
  S.row = anomalyRow({ product_id: 'pro_test_day' }) // 旧 id：`proCatalog` 里没有 ⇒ 期限查不到
  const res = await admin(good({ action: 'credit' }))
  check('4.11 道具期限查不到 ⇒ 503 credit_incomplete、账本一行不写、并说清这一行现在是 pending', [res.status, res.body.code, res.body.now, ledgerPosts().length, String(res.body.error).includes('A4')], [503, 'credit_incomplete', 'pending', 0, true])
}
{
  reset()
  withQuery(Q_PAID)
  S.patchRows = [] // CAS 匹配 0 行（有人抢先）
  const res = await admin(good({ action: 'credit' }))
  check('4.12 🔴 CAS 匹配 0 行 ⇒ 409 且**不去调用入账**（查单只发生我这一次；第二次没有＝没有偷偷改）', [res.status, res.body.code, queryCalls().length, ledgerPosts().length], [409, 'anomaly_raced', 1, 0])
}
{
  reset()
  withQuery(Q_PAID)
  S.ledgerReadStatus = 500 // 入账成功，但回读那一眼失败
  const res = await admin(good({ action: 'credit' }))
  check('4.13 回读失败 ⇒ 不许把"我以为写了"当没问题（verifyFailed:true，而不是静默报成功）', [res.status, res.body.verifyFailed, res.body.coverageLive], [200, true, false])
}
{
  reset()
  withQuery(Q_PAID)
  S.row = anomalyRow({ status: 'pending', anomaly_reason: null })
  const res = await admin(good({ action: 'credit' }))
  check('4.14 pending 行也走同一条路（CAS 的过滤跟着读到的状态变，不是硬编码 anomaly）', [res.status, urlAt(orderPatches()).includes('status=eq.pending'), res.body.coverageLive], [200, true, true])
}

// ── 5. refunded：先撤权益、后改状态 ────────────────────────────────────────
reset()
withQuery(Q_REFUNDED)
S.ledgerLive = [{ id: 'l-1' }]
r = await admin(good({ action: 'refunded' }))
check('5.1 平台答已退 ⇒ 200、status=refunded、活权益被撤掉', [r.status, r.body.status, r.body.ledgerMoved], [200, 'refunded', 'revoked'])
{
  const revIdx = firstIdx((c) => c.url.includes('/rest/v1/pro_ledger') && c.method === 'PATCH')
  const casIdx = firstIdx((c) => c.url.includes('/rest/v1/pro_orders') && c.method === 'PATCH')
  check('5.2 🔴 写序＝先撤账本、后改订单状态（反过来就留下"订单说已退款、权益却还在"＝E-20② 那个现场）', [revIdx >= 0, casIdx > revIdx], [true, true])
  check('5.3 撤账过滤 revoked_at=is.null（重放这一支不会把撤销时刻挪后，也不会撤第二次）', urlAt(ledgerPatches()).includes('revoked_at=is.null'), true)
  const b = bodyAt(orderPatches())
  check('5.4 paid_at 已有值 ⇒ 这一次不重写它（🔴 它是 7 天窗口的起点，动了就是改历史）', Object.keys(b).includes('paid_at'), false)
  check('5.5 留痕里带上平台侧退款单号（refund_info 是**数组**、一笔可分多次退；这张表没有 wx_refund_id 列，这是唯一落点）', [String(b.note).includes('VPR26100503079104810'), String(b.note).includes('admin:refunded by owner'), String(b.note).includes('E-17 判丙')], [true, true, true])
}
{
  reset()
  withQuery(Q_REFUNDED)
  S.row = anomalyRow({ paid_at: null })
  const res = await admin(good({ action: 'refunded' }))
  check('5.6 🔴 E-19 那一格：paid_at 为空时按平台 paid_time 回填（库侧 CHECK 不许 refunded 的 paid_at 为空，不回填＝整条 PATCH 抛 23514）', [res.status, bodyAt(orderPatches()).paid_at, res.body.paidAtBackfilled], [200, PAID_ISO, true])
}
{
  reset()
  withQuery({ status: 5, paid_time: 0, paid_fee: 1 })
  S.row = anomalyRow({ paid_at: null })
  const res = await admin(good({ action: 'refunded' }))
  check('5.7 paid_at 为空而平台也没给时刻 ⇒ 409 refund_needs_paid_at 且**一次写都没有**（🔴 绝不拿"本次时刻"冒充付款时刻）', [res.status, res.body.code, writes().length, ledgerPatches().length], [409, 'refund_needs_paid_at', 0, 0])
}
{
  reset()
  withQuery(Q_REFUNDED)
  const res = await admin(good({ action: 'refunded' }))
  check('5.8 名下没有活权益（从没入账／已被撤过）⇒ 仍算收口成功，但 ledgerMoved 说清是 nothing_to_revoke', [res.status, res.body.ledgerMoved], [200, 'nothing_to_revoke'])
}
{
  reset()
  withQuery(Q_REFUNDED)
  S.ledgerLive = [{ id: 'l-1' }]
  S.patchRows = []
  const res = await admin(good({ action: 'refunded' }))
  check('5.9 🔴 撤了权益而 CAS 没匹配到（有人抢先改了状态）⇒ 409 并把 ledgerMoved 一起回，不静默成 200', [res.status, res.body.code, res.body.ledgerMoved], [409, 'anomaly_raced', 'revoked'])
}
{
  reset()
  withQuery(Q_REFUNDED)
  S.ledgerLive = [{ id: 'l-1' }]
  S.patchStatus = 400
  const res = await admin(good({ action: 'refunded' }))
  check('5.10 改状态那一步库侧报错（CHECK 或网络）⇒ 503，🔴 但撤账已经发生这件事不许被"什么都没动"掩盖', [res.status, res.body.code, ledgerPatches().length], [503, 'pro_unavailable', 1])
}

// ── 6. closed：只关"根本没付过"的 ──────────────────────────────────────────
reset()
withQuery(Q_CLOSED)
r = await admin(good({ action: 'closed' }))
check('6.1 平台答已关闭 ⇒ 200、status=closed、ledgerMoved=none_live', [r.status, r.body.status, r.body.ledgerMoved], [200, 'closed', 'none_live'])
check('6.2 🔴 closed 这一支**一次都不碰账本**（它不许当撤权益的通道：撤权益只有退款那两条正当来源）', [ledgerPatches().length, ledgerPosts().length], [0, 0])
{
  reset()
  withQuery(Q_UNPAID)
  S.ledgerLive = [{ id: 'l-1' }]
  const res = await admin(good({ action: 'closed' }))
  check('6.3 名下还有活权益 ⇒ 409 closed_would_drop_coverage 且零写（要入账走 credit、真退了钱走 refunded，别用 closed 抹）', [res.status, res.body.code, writes().length, ledgerPatches().length], [409, 'closed_would_drop_coverage', 0, 0])
  check('6.3b 那道读是在**任何写之前**发生的（先写后读＝这道门是装饰）', [firstIdx((c) => c.url.includes('revoked_at=is.null')) >= 0, writes().length], [true, 0])
}
{
  reset()
  withQuery(Q_UNPAID)
  S.ledgerReadStatus = 500
  const res = await admin(good({ action: 'closed' }))
  check('6.4 活权益读不到 ⇒ 503 且零写（判不出就不动，与 4.5 三态同一条纪律）', [res.status, res.body.code, writes().length], [503, 'pro_unavailable', 0])
}
{
  reset()
  withQuery(Q_UNPAID)
  S.row = anomalyRow({ status: 'pending', anomaly_reason: null })
  const res = await admin(good({ action: 'closed' }))
  check('6.5 closed 对 pending 同样可用 ⇒ 与 4.5 前置④"关旧建新"是同一条边（人工触发，不是新语义）', [res.status, res.body.from, res.body.status, urlAt(orderPatches()).includes('status=eq.pending')], [200, 'pending', 'closed', true])
}

// ── 7. 响应面 ──────────────────────────────────────────────────────────────
reset()
withQuery(Q_REFUNDED)
S.ledgerLive = [{ id: 'l-1' }]
r = await admin(good({ action: 'refunded' }))
check('7.1 🔴 响应里没有 payer_openid／openid／note／callback_raw 这几个键（管理员写的 note 里可能有客服对话内容）', ['payer_openid', 'openid', 'note', 'callback_raw', 'buyer_user_id', 'user_id'].filter((k) => JSON.stringify(r.body).includes('"' + k + '"')), [])
check('7.2 成功响应带的是审计要的那三样：这一行从哪个状态、被收到哪个状态、单号', [r.body.outTradeNo, r.body.from, r.body.action, r.body.status], [NO, 'anomaly', 'refunded', 'refunded'])
{
  reset()
  withQuery(Q_PAID)
  const res = await admin(good({ action: 'credit', payerOpenid: 'oAttack', durationDays: 3650, productId: 'yearly_mem_android', operator2: 'x' }))
  check('7.3 请求体里塞 payer_openid／durationDays／productId 一律不认（账本行仍按订单行与月卡 30 天写）', [res.status, bodyAt(ledgerPosts()).duration_days, bodyAt(ledgerPosts()).payer_openid], [200, DURATION_MONTHLY, OPENID])
}

// ── 8. 静态闸 ───────────────────────────────────────────────────────────────
const JS = []
;(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.js')) JS.push(p)
  }
})(path.join(root, 'functions'))
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
// 🔴 顺序不能反：**先剥整行注释，再剥块注释**。反过来的话，本端点头部注释里那句
//   "`/api/**` 那层中间件"里的 `/**` 会被当成块注释的起点，一路吞到下一个 `*/`——
//   import 那几行就这样从"代码"里消失，于是 8.2 那道"不许 import 入账写函数"的门
//   变成一道**扫空文件**的恒绿守卫（B3 那一轮"注释里的反例把静态门染红"的镜像形态：
//   这次不是染红，是**染绿**，比红坏得多）。
const codeOf = (p) =>
  read(p)
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
const storeSrc = readFileSync(path.join(root, 'functions/_lib/proStore.js'), 'utf8')
const anomalySrc = readFileSync(path.join(root, 'functions/admin/pro-anomaly.js'), 'utf8')
const ANOM = path.join(root, 'functions/admin/pro-anomaly.js')

check('8.1 🔴 三张会员表的 URL 只出现在 proStore.js（4.6"写这三张表的模块只有一个"，管理端也算）',
  JS.filter((p) => !p.includes('proStore.js') && /rest\/v1\/pro_(orders|ledger|refund_requests)/.test(codeOf(p))).map((p) => path.relative(root, p)), [])

check('8.2 出边端点不 import 入账与入边那几件写函数（paid／账本行／标 anomaly 都不许它直接写）',
  ['insertLedgerRow', 'markOrderPaid', 'markOrderAnomaly', 'markOrderRefunded', 'closePendingOrder', 'unrevokeLedgerForOrder'].filter((k) => new RegExp('\\b' + k + '\\b').test(codeOf(ANOM))), [])

check('8.3 🔴 creditOrder 不许为管理端开"这一行的异常态可以跳过"这类口子（4.5 第 3 步是结构，不是纪律）',
  [/allowAnomaly/, /isAdmin/, /adminMode/, /ADMIN_FORCE/, /FORCE_/, /override/, /skipAnomaly/].some((re) => re.test(codeOf(path.join(root, 'functions/_lib/proCredit.js')))), false)

// 🔴 8.3 那一串"不许出现的名字"是**黑名单**，反证 A10 证明它会漏：改名叫 `env.ADMIN_FORCE` 就绕过去了。
//   所以这里补一道**正向形状门**：那一支必须长成"无条件拒绝"的样子——一个 `if`、一个 `return`，
//   中间不许有 `&&`／`||`／第三个参数。改名逃得过黑名单，逃不过形状。
check('8.4 🔴 anomaly 那一支的形状＝无条件拒绝（不许出现 `&&`／`||` 之类的"除非…"）',
  [/if \(row\.status === 'anomaly'\) return \{ outcome: 'anomaly_held'/.test(codeOf(path.join(root, 'functions/_lib/proCredit.js'))), /row\.status === 'anomaly'[^)]*(&&|\|\|)/.test(codeOf(path.join(root, 'functions/_lib/proCredit.js')))],
  [true, false])

check('8.5 🔴 PRO_ADMIN_TOKEN 只有一个读者（两个管理端入口共用同一把门，抄两份必漂移）',
  JS.filter((p) => /PRO_ADMIN_TOKEN/.test(codeOf(p))).map((p) => path.relative(root, p)), ['functions\\_lib\\proAdminGuard.js'])

check('8.6 出边的写函数全仓只有一个，且它的目标状态枚举里**没有 paid**（paid 只能由入账事务写）',
  [JS.filter((p) => /ANOMALY_FROM/.test(codeOf(p))).length, /const ANOMALY_TO = \['pending', 'refunded', 'closed'\]/.test(storeSrc)],
  [1, true])

check('8.7 出边端点不看购买开关（关着闸门也得能收口——与 /push/xpay、refund-requests 同一条理由）',
  /PRO_PURCHASE_ENABLED|readProFlags/.test(codeOf(ANOM)), false)

{
  const needs = readsRowFieldsOf(anomalySrc)
  const cols = selectColsOf(storeSrc, 'getOrderForAdminByOutTradeNo')
  check('8.8 🔴 端点读的每个 row.X 必须在管理端那条读路的 select 里（E-31／E-35 同族：消费者读生产者没喂的键＝判定恒假）',
    [needs, needs.filter((c) => !cols.includes(c))],
    [['env', 'id', 'note', 'paid_at', 'payer_openid', 'status'], []])
  check('8.9 而 `note` 只在管理端这一条读路里（用户侧那两条 select 读到它＝把内部取证喂给了端点）',
    [cols.includes('note'), ['getOrderRow', 'listOrdersByOpenid'].map((f) => selectColsOf(storeSrc, f).includes('note'))],
    [true, [false, false]])
}

check('8.10 🔴 paid_time 的秒→毫秒换算全仓只有一份（两份实现＝两份"1970 年到期"，E-19 那一族）',
  JS.filter((p) => /1e11/.test(codeOf(p))).map((p) => path.relative(root, p)), ['functions\\_lib\\proXpay.js'])

{
  const adminFiles = JS.filter((p) => p.includes(path.sep + 'admin' + path.sep)).sort()
  check('8.11 管理端两个入口都在，且都从 proAdminGuard 拿门（"同一把 token、同一套留痕门"这句要靠结构成立，不靠注释）',
    [adminFiles.map((p) => path.relative(root, p)), adminFiles.filter((p) => !/proAdminGuard/.test(codeOf(p))).map((p) => path.relative(root, p))],
    [['functions\\admin\\pro-anomaly.js', 'functions\\admin\\pro-refunds.js'], []])
  check('8.11b 而这两个文件里没有一份自己写的凭证比较（定长比较在别处还有正当用途：探针、推送验签，所以只数 admin 目录）',
    adminFiles.filter((p) => /charCodeAt/.test(codeOf(p))).map((p) => path.relative(root, p)), [])
}

const failed = results.filter((x) => !x.ok)
for (const x of failed) console.log(`✗ ${x.name}\n    got  ${JSON.stringify(x.got)}\n    want ${JSON.stringify(x.want)}`)
console.log(`${results.length - failed.length}/${results.length} 格通过`)
if (failed.length) process.exitCode = 1

// ── 反证记录（两类都**真跑过**，跑单＝`scripts/_scratch/anomaly-falsification.mjs`：
//   每次只改坏一处，跑完还原并复跑本表确认回到 66/66。下面记的是**实际看到的红格**，不是期望值）──
// A 类＝把实现写坏，看该红的格子红：
//   A1 证据门不再挡任何方向（EVIDENCE 判定短路）    ⇒ 3.1 / 3.3 / 3.6 红，全在证据族
//   A2 CAS 的 WHERE 去掉"我读到的那个状态"          ⇒ 4.3 / 4.14 / 6.5 红（钉过滤条件的那三格）
//   A3 refunded 不撤账就改状态（E-20② 那个现场）    ⇒ 5.1 / 5.2 / 5.3 / 5.9 / 5.10 五格红
//   A4 删掉 paid_at 回填                            ⇒ 只有 5.6 红
//   A5 平台没给时刻时不拒、拿"本次时刻"顶上          ⇒ 只有 5.7 红
//   A6 note 覆盖而不是追加                          ⇒ 4.5 / 5.5 两格红
//   A7 不判 CAS 结果（拿 HTTP 200 当"改到了"）      ⇒ 只有 4.12 红
//   A8 admission 放进 paid                          ⇒ 2.2 里 paid 那一格红，另两格仍绿（各管各的）
//   A9 端点自己宣布"已入账"而不走唯一那份实现        ⇒ 10 格红（4.1/4.2/4.6–4.11/4.14/7.3）
//      ⇒ **"宣布而不做"是这张表抓得最狠的一种**，因为它的症状正是 E-19 那次的形状
//   A10 管理端 import 那个直接写 paid 的函数        ⇒ 8.2 红
//   A10b 改名叫 `env.ADMIN_FORCE` 绕开 8.3 的黑名单  ⇒ 8.3 与 8.4 两格一起红
//   A10c 整支删掉"anomaly 拒绝复活"                 ⇒ 8.4 红（行为层还有 `test:credit` 5.10 那一格）
// 🔴 A10b 是这一轮反证**当场抓出来的洞**：8.3 原来是黑名单（`allowAnomaly`／`isAdmin`／`\badmin\b`），
//   换个名字就逃得过去——黑名单挡不住"改了名的同一种改法"。补的 8.4 是**正向形状门**：那一支必须
//   长成"一个 if、一个 return、中间没有 `&&`／`||`"的样子。改名逃得过黑名单，逃不过形状。
// B 类＝撤掉判据本身，确认红格不是被别的东西代偿出来的：
//   B1 真把 8.8 改成自洽（＝恒绿）＋ 从管理端读路删掉 `note` ⇒ 4.5 / 5.5 与 8.9 三格仍红
//      ⇒ "消费者读生产者没喂的键"这一族今天有**四层**（行为两格＋8.9＋8.8），撤掉任一层仍有人兜
//   B2 把 writes() 放宽成"任何 POST/PATCH"          ⇒ 6 格红（3.1/3.5/5.7/6.3/6.3b/6.4）
//      ⇒ 计数口径不按目标系统收窄，"零写"那族就是**假红**；假红会把人训练成不看红格
//   B3 把 8.5 的期望改成"含 pro-refunds.js"         ⇒ 8.5 立刻红（它不是恒真的字符串匹配）
//   B4 把 codeOf 换回"先剥块注释"的旧顺序           ⇒ 8.11 红；🔴 而它与 A10 合跑（B5）时 **8.2 不红**
//      ⇒ 旧顺序会把头注里那句 `/api/**` 当成块注释的起点，一路吞掉 import 那几行，于是 8.2 扫的是
//        "没有 import 的空文件"＝一道**恒绿守卫**。顺序修好之后 A10 才真的红。
//        教训：静态门不只判据内容要紧，**着力点有没有被剥掉**也要紧——"染绿"比"染红"危险得多。
// ⚠️ 跑单自己被抓出两件事（都已写进那个文件）：
//   · 变异把源码改成语法错时这张表**一格都不红**（跑不起来）⇒ "没有红格"绝不等于"门没牙"。
//     A5 第一次就是这么假通过的，现在收尾行没打出来就按"崩了"报，红格数视为无效。
//   · `JSON.stringify([undefined]) === JSON.stringify([null])` ⇒ "没有那个键"与"那个键是 undefined"
//     在这一族判据里长得一模一样，要断**键在不在**（5.4 第一版就是这么写的，已改成 Object.keys）。
