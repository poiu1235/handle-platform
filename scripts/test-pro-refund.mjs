// B4 退款申请侧的离线判据：跑**真源码** `_lib/proRefund.js` 与 `functions/api/pro/refund-requests/index.js`
// （fetch 打桩成假 Supabase）。用法：npm run test:refund
//
// 这一份重点只有一句话：**"不合格当场拒、一行都不落"**（6.1 修正一）与
// **`manual`／`external` 不许从端上传进来**（那两类不耗额度＝绕过"每付款微信一次"的现成口子）。
// 其余资格判据都是纯函数级的分支覆盖——它们出错时症状都是静默的（要么多退、要么该退的退不了）。
//
// ⚠️ 它证明不了的：管理端（done／rejected 与"还回去"）——那一批还没写；
//   以及 E-28 那条"按 platform 分撤不撤"在真机上到底表现如何（今天只有这一份离线判据）。
import path from 'node:path'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { pickToSelect, readsRowFieldsOf, selectColsOf } from './_lib/producerShape.mjs'

const root = path.resolve(import.meta.dirname, '..')
const results = []
const check = (name, got, want) => results.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want })

const { evaluateRefund } = await import(pathToFileURL(path.join(root, 'functions/_lib/proRefund.js')).href)
const { onRequestPost } = await import(pathToFileURL(path.join(root, 'functions/api/pro/refund-requests/index.js')).href)
const { onRequestPost: onRequestAdminPost } = await import(pathToFileURL(path.join(root, 'functions/admin/pro-refunds.js')).href)
const { onRequestGet } = await import(pathToFileURL(path.join(root, 'functions/api/pro/orders/index.js')).href)

// 🔴 窗口长度在这里写**字面值**，故意不 import `REFUND_WINDOW_MS`：判据去引用被测常量的话，
//   把 7 天改成 30 天这两格照样绿（反向复现 R3 实测到了这一点——那是一道没牙的门）。
const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000

const OID = '11111111-1111-4111-8111-111111111111'
const NO = 'T179119458147228aba7d3'
const OPENID = 'ob9w-3fSO7EjTCQTM2JyHacr2RsU'
const UID = 'u-1'
const NOW = Date.parse('2026-10-05T10:00:00Z')
const PAID_ISO = new Date(NOW - 3600_000).toISOString() // 一小时前付的，稳在 7 天内

const row = (over = {}) => ({
  id: OID,
  user_id: UID,
  provider: 'wechat_mp',
  payer_openid: OPENID,
  out_trade_no: NO,
  product_id: 'monthly_mem_android',
  platform: 'android',
  goods_price: 333,
  env: 0,
  status: 'paid',
  paid_at: PAID_ISO,
  is_duplicate: false,
  ...over,
})
// 🔴 E-31 那一族的**申请端点侧**判据（2026-10-05 夜第二次撞到）：`getOrderRow` 的 select 原来漏了
//   `platform`，而 E-28 判丙之后 `evaluateRefund` 的 revokeNow 读的就是它 ⇒ 安卓的单也永远判成
//   "不当场撤"。桩里喂的行是手写的、带着那一列 ⇒ 判据必须**按真实 select 裁一遍**再进端点。
const storeSrc = readFileSync(path.join(root, 'functions/_lib/proStore.js'), 'utf8')
const refundSrc = readFileSync(path.join(root, 'functions/_lib/proRefund.js'), 'utf8')
const asStoredRow = (r) => pickToSelect(selectColsOf(storeSrc, 'getOrderRow'), r)
{
  const needs = readsRowFieldsOf(refundSrc)
  const missing = ['getOrderRow', 'listOrdersByOpenid'].map((fn) => [fn, needs.filter((c) => !selectColsOf(storeSrc, fn).includes(c))])
  check('2.0b 🔴 资格函数读的每个 row.X 必须在**两个生产者**的 select 里（一条读路漏列＝那一侧的判定恒假）',
    [needs, missing],
    [['env', 'id', 'is_duplicate', 'paid_at', 'payer_openid', 'platform', 'status'], [['getOrderRow', []], ['listOrdersByOpenid', []]]])
}

const ev = (over = {}) => evaluateRefund({ row: row(), payerOpenid: OPENID, kind: 'no_reason', nowMs: NOW, requestsForPayer: [], ...over })

// ── 1. 资格判据（纯函数）────────────────────────────────────────────────────
check('1.1 安卓合格单 ⇒ ok 且**当场撤**（D-22 的"点了就撤"）', ev(), { ok: true, revokeNow: true, orderId: OID })
check('1.2 iOS 合格单 ⇒ ok 但**不撤**（Apple 决定是否退，先撤就成了"钱没退、权益先没了"）', ev({ row: row({ platform: 'ios', product_id: 'monthly_mem_apple' }) }).revokeNow, false)
check('1.3 platform=unknown ⇒ 保守方向＝不撤', ev({ row: row({ platform: 'unknown' }) }).revokeNow, false)
check('1.4 🔴 端上传 manual ⇒ 拒（它不耗额度＝绕过"每微信一次"的口子）', ev({ kind: 'manual' }).code, 'refund_kind_not_allowed')
check('1.5 🔴 端上传 external ⇒ 同样拒（那是平台侧回流的类型）', ev({ kind: 'external' }).code, 'refund_kind_not_allowed')
check('1.6 duplicate 但系统没判成并发多付 ⇒ 拒（不耗额度的类型必须钉在事实上）', ev({ kind: 'duplicate' }).code, 'refund_kind_not_applicable')
check('1.7 duplicate 且 is_duplicate=true ⇒ 通过', ev({ kind: 'duplicate', row: row({ is_duplicate: true }) }).ok, true)
check('1.8 超出 7 天**一毫秒** ⇒ 拒（边界要贴着判，否则"多给一小时"这类改动测不出来）', ev({ row: row({ paid_at: new Date(NOW - SEVEN_DAYS_MS - 1).toISOString() }) }).code, 'refund_window_closed')
check('1.9 恰好 7 天整 ⇒ 通过（边界按"≤"，与 6.1 那句"7 天内可退"同形）', ev({ row: row({ paid_at: new Date(NOW - SEVEN_DAYS_MS).toISOString() }) }).ok, true)
check('1.10 paid_at 读不出 ⇒ 拒，不"当它没过窗口"（那是窗口的起点，不是可选项）', ev({ row: row({ paid_at: null }) }).code, 'refund_no_paid_at')
check('1.11 订单不是 paid ⇒ 拒（pending/closed/anomaly/refunded 四种都不是"能退的已付单"）', ['pending', 'closed', 'anomaly', 'refunded'].map((s) => ev({ row: row({ status: s }) }).code), ['refund_not_paid', 'refund_not_paid', 'refund_not_paid', 'refund_not_paid'])
check('1.12 env=1（沙箱单）⇒ 拒（现网申请不能碰沙箱那批行）', ev({ row: row({ env: 1 }) }).code, 'refund_env_mismatch')
check('1.13 🔴 申请人 openid 与订单 payer_openid 不同 ⇒ 拒（4.7 归属判据，不看 user_id）', ev({ row: row({ payer_openid: 'oSomeoneElse' }) }).code, 'openid_mismatch')
check('1.14 同一笔已有 pending 申请 ⇒ 不许重复申请', ev({ requestsForPayer: [{ order_id: OID, kind: 'no_reason', status: 'pending' }] }).code, 'refund_already_requested')
check('1.15 同一笔的申请被拒过 ⇒ 可以再申请（6.1 修正④：被拒归还）', ev({ requestsForPayer: [{ order_id: OID, kind: 'no_reason', status: 'rejected' }] }).ok, true)
check('1.16 🔴 额度按**付款微信**算：另一笔订单上已有一次 done 的 no_reason ⇒ 这一笔不能再无理由退', ev({ requestsForPayer: [{ order_id: 'other', kind: 'no_reason', status: 'done' }] }).code, 'refund_quota_used')
check('1.17 已经用过 no_reason 额度时，duplicate 那一类仍可申请（它本来就不占额度）', ev({ kind: 'duplicate', row: row({ is_duplicate: true }), requestsForPayer: [{ order_id: 'other', kind: 'no_reason', status: 'done' }] }).ok, true)

// ── 2. 端点（真源码，fetch 打桩）─────────────────────────────────────────────
let calls = []
let stub = {}
const reset = () => {
  calls = []
  stub = {
    orderRow: row(),
    ids: [OID],
    requests: [],
    insertStatus: 201,
    insertRows: [{ id: 'r-1', order_id: OID, kind: 'no_reason', status: 'pending' }],
    identityRows: [{ openid: OPENID }],
    revokeRows: [{ id: 'l-1' }],
    revokeStatus: 200,
  }
}
globalThis.fetch = async (url, options) => {
  const u = String(url)
  const method = (options && options.method) || 'GET'
  const body = options && options.body ? JSON.parse(options.body) : null
  calls.push({ url: u, method, body })
  const mk = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
  if (u.includes('/rest/v1/user_identities')) return mk(stub.identityRows)
  if (u.includes('/rest/v1/pro_refund_requests') && method === 'POST') return mk(stub.insertRows, stub.insertStatus)
  if (u.includes('/rest/v1/pro_refund_requests')) return mk(stub.requests)
  if (u.includes('/rest/v1/pro_ledger') && method === 'PATCH') {
    if (stub.revokeStatus !== 200) return mk({ message: 'revoke boom' }, stub.revokeStatus)
    return mk(stub.revokeRows)
  }
  if (u.includes('/rest/v1/pro_orders') && u.includes('select=id&')) return mk(stub.ids.map((id) => ({ id })))
  if (u.includes('/rest/v1/pro_orders')) return mk([asStoredRow(stub.orderRow)])
  throw new Error('未预期的出网目标：' + u)
}
const env = (over = {}) => ({
  SUPABASE_URL: 'https://fake',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  PRO_WALLS_ENABLED: 'true',
  PRO_PURCHASE_ENABLED: 'true',
  PRO_ENV: '0',
  PRO_TEST_OPENIDS: '',
  ...over,
})
const ctx = (body, eover = {}, user = { user: { id: UID } }) => ({
  request: { json: async () => body },
  env: env(eover),
  data: user,
})
// `json()` 回的是真 Response（body 是流）⇒ 判据要的是解析后的对象，别拿流去比（比出来永远是 {}）
const post = async (body, eover = {}, user = { user: { id: UID } }) => {
  const res = await onRequestPost(ctx(body, eover, user))
  return { status: res.status, body: await res.json().catch(() => null) }
}

// 🔴 取"那一次调用"要给缺调用哨兵：反证时判据被拒⇒根本没发出去，裸下标会抛 TypeError 把整张表崩掉
const MISSING = '‹没有那次调用›'
const bodyAt = (list, i = 0) => (list[i] ? list[i].body : MISSING)
const urlAt = (list, i = 0) => (list[i] ? list[i].url : MISSING)
const reqCalls = () => calls.filter((c) => c.url.includes('/rest/v1/pro_refund_requests') && c.method === 'POST')
const ledgerPatches = () => calls.filter((c) => c.url.includes('/rest/v1/pro_ledger') && c.method === 'PATCH')

reset()
let r = await post({ outTradeNo: NO, kind: 'no_reason' })
check('2.1 安卓合格申请 ⇒ 200、status=pending、revoked:true、viaAppStore:false', [r.status, r.body], [200, { outTradeNo: NO, status: 'pending', revoked: true, viaAppStore: false }])
{
  const insIdx = calls.findIndex((c) => c.url.includes('/rest/v1/pro_refund_requests') && c.method === 'POST')
  const revIdx = calls.findIndex((c) => c.url.includes('/rest/v1/pro_ledger') && c.method === 'PATCH')
  check('2.2 🔴 写序＝先落申请行、后撤账本（申请行是唯一能证明"这个人申请过"的东西）', [insIdx >= 0, revIdx > insIdx], [true, true])
  check('2.3 申请行带 order_id＋kind＋status=pending', bodyAt(reqCalls()), { order_id: OID, kind: 'no_reason', status: 'pending' })
  check('2.4 撤账那一条过滤 revoked_at=is.null（重放不挪撤销时刻）', urlAt(ledgerPatches()).includes('revoked_at=is.null'), true)
}

reset()
stub.orderRow = row({ platform: 'ios', product_id: 'monthly_mem_apple' })
r = await post({ outTradeNo: NO, kind: 'no_reason' })
check('2.5 🔴 iOS 合格申请 ⇒ 落行但**账本零 PATCH**（E-28 判丙的那一半），且回 `viaAppStore:true`（#67② 那句"去 App Store"的判据）',
  [r.status, r.body.revoked, r.body.viaAppStore, reqCalls().length, ledgerPatches().length], [200, false, true, 1, 0])

reset()
stub.orderRow = row({ platform: 'unknown' })
r = await post({ outTradeNo: NO, kind: 'no_reason' })
check('2.5b 🔴 `unknown`（工具／桌面）也不撤账，但**不许**回 viaAppStore——把商店那句指给它是假信息',
  [r.status, r.body.revoked, r.body.viaAppStore, ledgerPatches().length], [200, false, false, 0])

reset()
stub.orderRow = row({ status: 'refunded' })
r = await post({ outTradeNo: NO, kind: 'no_reason' })
check('2.6 🔴 不合格（已退过）⇒ 409 且 pro_refund_requests **零 POST**（"不合格当场拒、一行都不落"）', [r.status, r.body.code, reqCalls().length], [409, 'refund_not_paid', 0])

reset()
stub.orderRow = row({ payer_openid: 'oSomeoneElse' })
r = await post({ outTradeNo: NO, kind: 'no_reason' })
check('2.7 别人的单 ⇒ 403 openid_mismatch、零落行（🔴 判定发生在打平台之前那一类形状：这里连读都不多读）', [r.status, r.body.code, reqCalls().length], [403, 'openid_mismatch', 0])

reset()
r = await post({ outTradeNo: NO, kind: 'manual' })
check('2.8 端上传 manual ⇒ 400 bad_request（判据之前先挡，两道都算）', [r.status, r.body.code, reqCalls().length], [400, 'bad_request', 0])

reset()
stub.identityRows = []
r = await post({ outTradeNo: NO, kind: 'no_reason' })
check('2.9 账号没绑微信 ⇒ 403 wechat_not_bound、零落行', [r.status, r.body.code, reqCalls().length], [403, 'wechat_not_bound', 0])

reset()
r = await post({ outTradeNo: NO, kind: 'no_reason' }, { PRO_PURCHASE_ENABLED: 'false' })
check('2.10 🔴 购买闸门关着 ⇒ 申请**仍然受理**（关着闸门不让人退款＝把已付费用户锁死）', [r.status, reqCalls().length], [200, 1])

reset()
stub.revokeStatus = 500
r = await post({ outTradeNo: NO, kind: 'no_reason' })
check('2.11 撤账失败 ⇒ 503，但申请行**不回滚**（它是 A1 巡检与用户重试时"正在处理中"的唯一凭据）', [r.status, r.body.code, reqCalls().length], [503, 'pro_unavailable', 1])

reset()
stub.insertStatus = 400
stub.insertRows = { message: 'boom' }
r = await post({ outTradeNo: NO, kind: 'no_reason' })
check('2.12 申请行落不下去 ⇒ 503 且**不撤账**（顺序门反过来就是"权益没了而没有任何记录"）', [r.status, r.body.code, ledgerPatches().length], [503, 'pro_unavailable', 0])

reset()
r = await post({ outTradeNo: NO, kind: 'no_reason' }, {}, {})
check('2.13 没有会话身份 ⇒ 401 且零出网', [r.status, calls.length], [401, 0])

// ── 4. 管理端（functions/admin/pro-refunds.js）───────────────────────────────
let stub2 = {}
const reset2 = (over = {}) => {
  calls = []
  stub2 = {
    request: { id: 'r-1', order_id: OID, kind: 'no_reason', status: 'pending', requested_at: '2026-10-05T09:00:00Z' },
    order: row(),
    otherRequests: [],
    revokeRows: [{ id: 'l-1' }],
    unrevokeRows: [{ id: 'l-1' }],
    finalizeRows: [{ id: 'r-1', status: 'done' }],
    ...over,
  }
}
globalThis.fetch = async (url, options) => {
  const u = String(url)
  const method = (options && options.method) || 'GET'
  calls.push({ url: u, method, body: options && options.body ? JSON.parse(options.body) : null })
  const mk = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
  if (u.includes('/rest/v1/pro_refund_requests') && method === 'PATCH') return mk(stub2.finalizeRows)
  if (u.includes('/rest/v1/pro_refund_requests') && method === 'GET') {
    return mk(u.includes('id=eq.') ? [stub2.request].filter(Boolean) : stub2.otherRequests)
  }
  if (u.includes('/rest/v1/pro_ledger') && method === 'PATCH') {
    return mk(u.includes('revoked_at=is.not.null') ? stub2.unrevokeRows : stub2.revokeRows)
  }
  if (u.includes('/rest/v1/pro_orders') && u.includes('id=eq.')) return mk([stub2.order])
  throw new Error('未预期的出网目标：' + u)
}
const admin = async (body, headers = { 'x-admin-token': 'adm-secret' }, eover = {}) => {
  const res = await onRequestAdminPost({
    request: {
      json: async () => body,
      headers: { get: (k) => (String(k).toLowerCase() === 'x-admin-token' ? headers['x-admin-token'] || null : null) },
    },
    env: { SUPABASE_URL: 'https://fake', SUPABASE_SERVICE_ROLE_KEY: 'k', PRO_ADMIN_TOKEN: 'adm-secret', ...eover },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const goodAdmin = (over = {}) => ({ id: 'r-1', action: 'done', operator: 'owner', note: '后台已退，回执见 wx_refund_id', wxRefundId: 'VPR123', ...over })
const finalizePatches = () => calls.filter((c) => c.url.includes('/rest/v1/pro_refund_requests') && c.method === 'PATCH')
const ledgerPatches2 = () => calls.filter((c) => c.url.includes('/rest/v1/pro_ledger') && c.method === 'PATCH')

reset2()
r = await admin(goodAdmin())
check('4.1 done ⇒ 200，账本先撤、申请行后改', [r.status, r.body.ledgerMoved], [200, 'revoked'])
{
  const revIdx = calls.findIndex((c) => c.url.includes('/rest/v1/pro_ledger') && c.method === 'PATCH')
  const finIdx = calls.findIndex((c) => c.url.includes('/rest/v1/pro_refund_requests') && c.method === 'PATCH')
  check('4.2 🔴 写序＝先动账本、后改申请行（反过来会留下"行已终态、账本没跟上"，而 pending 过滤把重试挡死）', [revIdx >= 0, finIdx > revIdx], [true, true])
  check('4.3 撤账过滤 revoked_at=is.null、改行过滤 status=eq.pending', [urlAt(ledgerPatches2()).includes('revoked_at=is.null'), urlAt(finalizePatches()).includes('status=eq.pending')], [true, true])
  check('4.4 留痕三样都落（#68：wx_refund_id＋operator＋note）', [bodyAt(finalizePatches()).wx_refund_id, bodyAt(finalizePatches()).operator, bodyAt(finalizePatches()).status], ['VPR123', 'owner', 'done'])
}

reset2()
stub2.revokeRows = []
r = await admin(goodAdmin())
check('4.5 撤账匹配 0 行（推送/轮询抢先撤过）⇒ 仍算成功，ledgerMoved=already_revoked', [r.status, r.body.ledgerMoved], [200, 'already_revoked'])

reset2()
r = await admin(goodAdmin({ action: 'rejected', wxRefundId: '' }))
check('4.6 rejected ⇒ 先还原权益、再改行（不退款 ⇒ 权益本来就该在）', [r.status, r.body.ledgerMoved, urlAt(ledgerPatches2()).includes('revoked_at=is.not.null')], [200, 'returned', true])

reset2()
stub2.order = row({ status: 'refunded' })
r = await admin(goodAdmin({ action: 'rejected', wxRefundId: '' }))
check('4.7 🔴 订单已 refunded（外部真退了钱）⇒ rejected 也**不许还原**（还原＝"钱退了、权益还在"那个现场）', [r.status, r.body.ledgerMoved, urlAt(ledgerPatches2()).includes('revoked_at=is.not.null')], [200, 'kept_revoked', false])

reset2()
stub2.otherRequests = [{ order_id: OID, kind: 'manual', status: 'done' }]
r = await admin(goodAdmin({ action: 'rejected', wxRefundId: '' }))
check('4.8 同一订单上还有另一条生效申请 ⇒ 不还原', [r.status, r.body.ledgerMoved], [200, 'kept_revoked'])

reset2()
stub2.request = { id: 'r-1', order_id: OID, kind: 'no_reason', status: 'done' }
r = await admin(goodAdmin())
check('4.9 申请行不是 pending ⇒ 409 且零写（重放／两个管理员同时点开）', [r.status, r.body.code, finalizePatches().length, ledgerPatches2().length], [409, 'refund_not_pending', 0, 0])

reset2()
stub2.request = null
r = await admin(goodAdmin())
check('4.10 没有这条申请 ⇒ 404 且零写', [r.status, r.body.code, calls.length], [404, 'no_such_request', 1])

reset2()
stub2.finalizeRows = []
r = await admin(goodAdmin())
check('4.11 账本动了、改行却匹配 0 行（被人抢先）⇒ 409，🔴 不静默成 200', [r.status, r.body.code], [409, 'refund_not_pending'])

reset2()
r = await admin(goodAdmin(), { 'x-admin-token': 'wrong' })
check('4.12 🔴 凭证不对 ⇒ 401 且**一次出网都没有**（未鉴权输入不许触发任何写）', [r.status, r.body.code, calls.length], [401, 'admin_unauthorized', 0])

reset2()
r = await admin(goodAdmin(), {}, { PRO_ADMIN_TOKEN: undefined })
check('4.13 没配 PRO_ADMIN_TOKEN ⇒ 503 admin_disabled（缺配置不许长得像"没有门"）', [r.status, r.body.code, calls.length], [503, 'admin_disabled', 0])

reset2()
r = await admin({ id: 'r-1', action: 'done', operator: '', note: '' })
check('4.14 缺 operator/note ⇒ 400 admin_note_required 且零写（#68 那道门今天**只在代码里**，库里没 CHECK＝E-29）', [r.status, r.body.code, calls.length], [400, 'admin_note_required', 0])

reset2()
r = await admin({ id: 'r-1', action: 'done', operator: 'owner', note: 'n' })
check('4.15 done 而缺 wx_refund_id ⇒ 400 且零写', [r.status, r.body.code, calls.length], [400, 'admin_wx_refund_id_required', 0])

// ── 5. 订单列表 join（6.1 ⑦ 进度看得见）──────────────────────────────────────
let stub3 = {}
const reset3 = (over = {}) => {
  calls = []
  stub3 = { orderRow: row(), ids: [OID], requests: [], identityRows: [{ openid: OPENID }], requestsFail: false, ...over }
}
globalThis.fetch = async (url, options) => {
  const u = String(url)
  const method = (options && options.method) || 'GET'
  calls.push({ url: u, method })
  const mk = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
  if (u.includes('/rest/v1/user_identities')) return mk(stub3.identityRows)
  if (u.includes('/rest/v1/pro_refund_requests')) {
    if (stub3.requestsFail) return mk({ message: 'boom' }, 500)
    return mk(stub3.requests)
  }
  if (u.includes('/rest/v1/pro_orders') && u.includes('select=id&')) return mk(stub3.ids.map((id) => ({ id })))
  if (u.includes('/rest/v1/pro_orders')) return mk([asStoredRow(stub3.orderRow)])
  throw new Error('未预期的出网目标：' + u)
}
const list = async () => {
  const res = await onRequestGet({ env: env(), data: { user: { id: UID } }, request: { json: async () => ({}) } })
  return { status: res.status, body: await res.json().catch(() => null) }
}

reset3()
r = await list()
check('5.1 没有申请行 ⇒ refundStatus=none、refundable=true（7 天内、安卓、额度没用过）', [r.body.orders[0].refundStatus, r.body.orders[0].refundable], ['none', true])

reset3()
stub3.requests = [{ order_id: OID, kind: 'no_reason', status: 'pending', requested_at: '2026-10-05T09:00:00Z' }]
r = await list()
check('5.2 有 pending 申请 ⇒ refundStatus=pending 且 refundable=false（不许重复申请）', [r.body.orders[0].refundStatus, r.body.orders[0].refundable], ['pending', false])

reset3()
stub3.orderRow = row({ platform: 'ios', product_id: 'monthly_mem_apple' })
r = await list()
check('5.3 iOS 单仍然可申请（E-28 那一条只管"撤不撤"，不管"能不能申请"）', r.body.orders[0].refundable, true)

reset3()
stub3.ids = [OID, 'other-id']
stub3.requests = [{ order_id: 'other-id', kind: 'no_reason', status: 'done', requested_at: '2026-09-01T09:00:00Z' }]
r = await list()
check('5.4 🔴 额度按付款微信跨订单算：另一笔已用过 no_reason ⇒ 这一笔 refundable=false', r.body.orders[0].refundable, false)

reset3()
stub3.orderRow = row({ status: 'refunded' })
r = await list()
check('5.5 已退的单 ⇒ refundable=false（按钮不该画给不能点的行）', r.body.orders[0].refundable, false)

reset3()
stub3.requestsFail = true
r = await list()
check('5.6 🔴 申请行读不到 ⇒ refundInfoUnavailable:true 且**所有行 refundable=false**（读不到就画成"能点"＝诱导重复申请／点了报错）', [r.body.refundInfoUnavailable, r.body.orders[0].refundable], [true, false])

reset3()
stub3.requests = [{ order_id: OID, kind: 'no_reason', status: 'rejected', requested_at: '2026-10-05T09:00:00Z' }]
r = await list()
check('5.7 被拒过的申请 ⇒ refundStatus=rejected 且额度归还（又能申请）', [r.body.orders[0].refundStatus, r.body.orders[0].refundable], ['rejected', true])
check('5.8 响应里没有 note／operator／wx_refund_id 这些自由文本键（管理员 note 里可能有客服对话内容）', ['note', 'operator', 'wx_refund_id'].some((k) => JSON.stringify(r.body).includes('"' + k + '"')), false)

// ── 3. 静态闸 ───────────────────────────────────────────────────────────────
const JS = []
;(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.js')) JS.push(p)
  }
})(path.join(root, 'functions'))
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const codeOf = (p) => read(p).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
check('3.1 🔴 pro_refund_requests 的 URL 只出现在 proStore.js（4.6 那五个入口共用一个写模块）', JS.filter((p) => !p.includes('proStore.js') && /rest\/v1\/pro_refund_requests/.test(codeOf(p))).map((p) => path.relative(root, p)), [])
check('3.2 申请端点不看购买开关（与 /push/xpay 同一条例外，两处都得写死）', /PRO_PURCHASE_ENABLED|readProFlags/.test(codeOf(path.join(root, 'functions/api/pro/refund-requests/index.js'))), false)
check('3.3 platform 的判定只发生在 proRefund.js 一处（E-28 那条例外不许被抄第二遍）', JS.filter((p) => /platform\)?\s*===\s*'android'/.test(codeOf(p))).map((p) => path.relative(root, p)), ['functions\\_lib\\proRefund.js'])
check('3.4 端点上没有直接打库的 serviceRoleFetch（读一律经 proStore）', /serviceRoleFetch/.test(codeOf(path.join(root, 'functions/api/pro/refund-requests/index.js'))), false)
// 🔴 E-31／E-35 那一族的第三次预防：申请行的读路有**三个**消费者要拿 `id` 寻址（管理端排除自己、
//   接收器关行、订单页取最新一条），而 select 原来是手写列名清单，漏一个就静默恒假。
check('3.5 🔴 refundRequestsByOrders 的 select 必须含 id（消费者按它寻址；漏了＝接收器关不了行）',
  selectColsOf(storeSrc, 'refundRequestsByOrders').includes('id'), true)

const failed = results.filter((x) => !x.ok)
for (const x of failed) console.log(`✗ ${x.name}\n    got  ${JSON.stringify(x.got)}\n    want ${JSON.stringify(x.want)}`)
console.log(`${results.length - failed.length}/${results.length} 格通过`)
if (failed.length) process.exitCode = 1
