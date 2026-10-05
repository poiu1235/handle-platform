// B3-2/B3-3 下单端点的离线判据：跑**真源码** functions/api/pro/orders/index.js（fetch 打桩成
// 假 Supabase、假 code2session 与假 xpay 查单）。
// 用法：npm run test:orders
//
// 为什么能这么跑：这个端点只用 fetch ＋ Web Crypto（crypto.subtle），没有 workerd 专有 API。
// 这台机器到 *.supabase.co / api.weixin.qq.com 的 TLS 被 SNI 重置 ⇒ 真链路只能部署后测，
// 但**七条前置的顺序、状态机、签名的输入**这三件事在本地就能判死——
// 尤其是"前置②没过不许有任何写动作"这一条，只有打桩能看到"几次 PATCH/POST"。
//
// ⚠️ 它证明不了的：微信是否接受这个 signData 字符串（R-9）、道具是否已在后台发布且价格逐字一致
//   （不一致的症状是拉起被平台拒）、`/xpay/query_order` 回给我们的 status 数值是否就是文档
//   那套 0–10 枚举（查单**怎么被解读**在 test-pro-xpay.mjs 里判，"真单回来的形状"只能部署后测）、
//   以及真机上 `wx.login` 的 code 与 Bearer 会话是否同一微信号（那是验收 #26/#36 的活）。

import crypto from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const results = []
const check = (name, got, want) => results.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want })
const expectHmac = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex')

const { onRequestPost, onRequestGet } = await import(pathToFileURL(path.join(root, 'functions/api/pro/orders/index.js')).href)

const UID = 'u-1'
const BOUND = 'oBound'
const SESSION_KEY = 'sk-demo-0123456789abcdef'

// ── 假后端 ─────────────────────────────────────────────────────────────────
let calls = []
let stub = {}
const defaultStub = () => ({
  identityRows: [{ openid: BOUND }],
  identityStatus: 200,
  pdelRows: [],
  pdelStatus: 200,
  coverageBody: { is_covered: false, valid_until: null, remaining_days: null },
  coverageStatus: 200,
  pendingRows: [],
  pendingStatus: 200,
  insertStatus: 201,
  insertError: null, // { code, message } ⇒ 撞库侧约束
  patchStatus: 200,
  // 🔴 订单页那颗退款按钮要读申请行（额度与进度都从它算）。这一路原来**没桩** ⇒ 端点里那句 catch
  //   把"没桩"吞成 `requests=null` ⇒ `refundInfoUnavailable:true`、每行 `refundable:false`，
  //   于是 10.x 那一段从来没算出过一次真的 `refundable`（这正是"判据绿着、按钮不存在"的形状）。
  refundRows: [],
  refundStatus: 200,
  wxBody: { openid: BOUND, session_key: SESSION_KEY, unionid: 'uBound' },
  wxOk: true,
  // 🔴 B3-3 之后**下单路径也会打 xpay**（前置④"换档先查单"）⇒ 桩里必须有这两条路由，
  //   否则"未预期的出网目标"会抛成 503，把网络桩的缺口伪装成业务结论。
  tokenBody: { access_token: 'TOKEN-x', expires_in: 7200 },
  queryBody: { errcode: 268490002, errmsg: '数据不存在' }, // 默认＝平台查无此单 ⇒ 可以关旧建新
})
const future = () => new Date(Date.now() + 60_000).toISOString()
const past = () => new Date(Date.now() - 60_000).toISOString()

globalThis.fetch = async (url, options) => {
  const u = String(url)
  const method = (options && options.method) || 'GET'
  const body = options && options.body ? JSON.parse(options.body) : null
  calls.push({ url: u, method, body })
  const mk = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
  if (u.includes('api.weixin.qq.com/sns/jscode2session')) return mk(stub.wxBody, stub.wxOk ? 200 : 200)
  if (u.includes('/cgi-bin/token')) return mk(stub.tokenBody)
  if (u.includes('/xpay/query_order')) return mk(stub.queryBody)
  if (u.includes('/rest/v1/rpc/pro_coverage')) return mk(stub.coverageBody, stub.coverageStatus)
  if (u.includes('/rest/v1/user_identities')) return mk(stub.identityRows, stub.identityStatus)
  if (u.includes('/rest/v1/pending_deletions')) return mk(stub.pdelRows, stub.pdelStatus)
  if (u.includes('/rest/v1/pro_orders') && method === 'POST') {
    if (stub.insertStatus !== 201) return mk(stub.insertError || { message: 'insert boom' }, stub.insertStatus)
    return mk({}, 201)
  }
  // PATCH 回**数组**：`markOrderPaid`/`closePendingOrder`/`markOrderAnomaly` 都带
  // `Prefer: return=representation`，代码会数"改到几行"（0 行＝没改成，要能分开）。
  if (u.includes('/rest/v1/pro_orders') && method === 'PATCH') return mk([{ status: 'closed' }], stub.patchStatus)
  if (u.includes('/rest/v1/pro_orders')) {
    if (stub.pendingStatus !== 200) return mk({ message: 'select boom' }, stub.pendingStatus)
    return mk(stub.pendingRows)
  }
  if (u.includes('/rest/v1/pro_refund_requests')) return mk(stub.refundRows, stub.refundStatus)
  throw new Error('未预期的出网目标：' + u)
}

const reset = () => {
  calls = []
  stub = defaultStub()
}
const env = (over = {}) => ({
  SUPABASE_URL: 'https://fake',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  PRO_WALLS_ENABLED: 'false',
  PRO_PURCHASE_ENABLED: 'true',
  PRO_ENV: '0',
  PRO_TEST_OPENIDS: '',
  WX_APPID: 'wx1',
  WX_SECRET: 'sec1',
  WX_PAY_OFFER_ID: 'offer-1',
  WX_PAY_APPKEY_PROD: 'appkey-1',
  ...over,
})
const req = (payload) =>
  new Request('https://cf/api/pro/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
const good = (over = {}) => ({ productId: 'monthly_mem_android', platform: 'android', code: 'code-1', ...over })
const run = async (payload, over = {}, eover = {}) => {
  const res = await onRequestPost({ request: req(payload), env: env(eover), data: { user: { id: UID, email: 'a@b.c' } } })
  return { status: res.status, body: await res.json() }
}
const writes = () => calls.filter((c) => c.url.includes('/rest/v1/pro_orders') && (c.method === 'POST' || c.method === 'PATCH'))

// 🔴 生产者侧的形状（10.4b 与 10.12…10.16 共用同一份解析，别抄两遍）：`listOrdersByOpenid` 的 select 列。
//   打桩喂的行原来是手写的、永远带着 `payer_openid` ⇒ 生产者漏列这种事在桩里看不出来
//   （2026-10-05 真机：订单页那颗「申请退款」按钮不出现，而这一段全绿）。
const listSelectColumns = () => {
  const src = readFileSync(path.join(root, 'functions/_lib/proStore.js'), 'utf8')
  const m = /listOrdersByOpenid[\s\S]{0,900}\?select=([a-z_,0-9]+)/.exec(src)
  if (!m) throw new Error('取不到 listOrdersByOpenid 的 select 列（这一族的形状改了，判据要跟着改）')
  return m[1].split(',')
}
const insertCalls = () => calls.filter((c) => c.url.includes('/rest/v1/pro_orders') && c.method === 'POST')
const patchCalls = () => calls.filter((c) => c.url.includes('/rest/v1/pro_orders') && c.method === 'PATCH')
const codeConsumed = () => calls.filter((c) => c.url.includes('jscode2session')).length
// 🔴 与 test-pro-credit 同一条纪律：取"第 N 次调用"要给一个**看得见的缺调用哨兵**，
//   否则"那次写根本没发生"会把整个脚本崩掉（红格一个都看不见），而不是让那一格红。
const MISSING = '‹没有那次调用›'
const bodyAt = (list, i = 0) => (list[i] ? list[i].body : MISSING)
const urlAt = (list, i = 0) => (list[i] ? list[i].url : MISSING)

// ── 1. 关态与脏请求：零次数据库、零次出网（8.3 第 1 条＋探测四笔账）──────────
reset()
let r = await run(good(), {}, { PRO_PURCHASE_ENABLED: 'false' })
check('1.1 购买开关关着 ⇒ 403 purchase_disabled', [r.status, r.body.code], [403, 'purchase_disabled'])
check('1.2 关态一次数据库都没问', calls.length, 0)

reset()
r = await onRequestPost({ request: req(good()), env: env(), data: {} })
check('1.3 没有会话身份 ⇒ 401 且零出网', [r.status, calls.length], [401, 0])

reset()
r = await run({ productId: 'monthly_mem_android', platform: 'android' })
check('1.4 缺 code ⇒ 400 且没消耗任何东西', [r.status, r.body.code, codeConsumed()], [400, 'no_wx_code', 0])
reset()
r = await run({ platform: 'android', code: 'c' })
check('1.5 缺 productId ⇒ 400 bad_request', [r.status, r.body.code], [400, 'bad_request'])
reset()
r = await run('{not json')
check('1.6 请求体不是合法 JSON ⇒ 400，不抛到外面', [r.status, r.body.code], [400, 'bad_request'])
reset()
r = await run(good({ productId: 'pro_month' }))
check('1.7 表里没有的道具 id ⇒ 400 且没读 identity、没烧 code', [r.status, r.body.code, calls.length, codeConsumed()], [400, 'product_unknown', 0, 0])

reset()
r = await run(good(), {}, { WX_PAY_APPKEY_PROD: '' })
check('1.8 🔴 缺 AppKey（secret 最容易漏配）⇒ 建单之前就 503', [r.status, r.body.code, writes().length], [503, 'pay_config_missing', 0])
reset()
r = await run(good(), {}, { WX_PAY_OFFER_ID: '' })
check('1.9 缺 offerId ⇒ 同样当场 503，零写', [r.status, r.body.code, writes().length], [503, 'pay_config_missing', 0])

// ── 2. 前置①②：账号绑着 wechat_mp，且当场 code 换来的就是那一条 ──────────────
reset()
stub.identityRows = []
r = await run(good())
check('2.1 纯 Web 账号（没绑微信）⇒ 403，🔴 且没消耗 code', [r.status, r.body.code, codeConsumed()], [403, 'wechat_not_bound', 0])

reset()
stub.identityStatus = 500
r = await run(good())
check('2.2 identity 读失败 ⇒ 503 拒单（判不出就不收钱，与 7.2 写路径"放行"相反且刻意）', [r.status, r.body.code], [503, 'pro_unavailable'])

reset()
stub.wxBody = { errcode: 40029, errmsg: 'invalid code' }
r = await run(good())
check('2.3 真 errcode ⇒ 400 wx_ticket_invalid（沿用 wxTicketResponse，不再各写一套文案）', [r.status, r.body.code], [400, 'wx_ticket_invalid'])
reset()
stub.wxBody = { openid: BOUND } // 🔴 没有 session_key：宁可拒单也不签废名（proPaySign 6.7 那条契约）
r = await run(good())
check('2.4 换取回包缺 session_key ⇒ 判失败 ⇒ 零写', writes().length, 0)
check('2.4b 这一支走的是 503（errcode=unparseable 属服务端那一格，不是"你的 code 无效"）', [r.status, r.body.code], [503, 'wx_ticket_unavailable'])

reset()
stub.wxBody = { openid: 'oSomeoneElse', session_key: SESSION_KEY, unionid: null }
r = await run(good())
check('2.5 🔴 前置②：当场 openid ≠ 绑定的那条 ⇒ 409 openid_mismatch', [r.status, r.body.code], [409, 'openid_mismatch'])
check('2.6 🔴 且文案是 7.5 第 10 条那一句（不是"系统错误"）', r.body.error.includes('请在你购买会员的那部微信里打开本小程序'), true)
check('2.7 🔴 且没有任何写动作、没有入账、没有落一行 pending', writes().length, 0)
check('2.8 响应体里没有 openid／unionid／session_key', ['oSomeoneElse', 'uBound', SESSION_KEY].filter((s) => JSON.stringify(r.body).includes(s)), [])

// ── 3. 前置③：注销冷静期拒 ─────────────────────────────────────────────────
reset()
stub.pdelRows = [{ reason: 'user_request' }]
r = await run(good())
check('3.1 pending_deletions 有行 ⇒ 409 deletion_pending 且零写', [r.status, r.body.code, writes().length], [409, 'deletion_pending', 0])
reset()
stub.pdelStatus = 500
r = await run(good())
check('3.2 冷静期查不到 ⇒ 503 拒（同样不许"先建单再说"）', [r.status, r.body.code, writes().length], [503, 'pro_unavailable', 0])

// ── 4. 前置⑥：两道方向相反的名单守卫 ───────────────────────────────────────
reset()
r = await run(good({ productId: 'monthly_test' }))
check('4.1 🔴 白名单为空时测试档对谁都拒（验收 #36 那条洞的边界）', [r.status, r.body.code, writes().length], [403, 'test_not_allowed', 0])
reset()
r = await run(good({ productId: 'monthly_test' }), {}, { PRO_TEST_OPENIDS: `${BOUND},other` })
check('4.2 白名单内 ⇒ 测试档可下单（1 分真实单）', [r.status, r.body.productId], [200, 'monthly_test'])
reset()
r = await run(good(), {}, { PRO_TEST_OPENIDS: 'someone,else' })
check('4.3 内测形态（名单非空）＋名单外 ⇒ 正常档也拒', [r.status, r.body.code], [403, 'not_on_sale'])
reset()
r = await run(good(), {}, { PRO_TEST_OPENIDS: BOUND })
check('4.4 内测形态＋名单内 ⇒ 正常档放行', [r.status, r.body.productId], [200, 'monthly_mem_android'])
reset()
stub.identityRows = [{ openid: 'oSomeoneElse' }]
stub.wxBody = { openid: 'oSomeoneElse', session_key: SESSION_KEY }
r = await run(good(), {}, { PRO_TEST_OPENIDS: 'oSomeoneElse' })
check('4.5 🔴 守卫与落库用的是同一个 openid：绑着的、当场换的、名单里的三者一致才放行', [r.status, r.body.code], [200, undefined])
reset()
stub.identityRows = [{ openid: 'oSomeoneElse' }]
stub.wxBody = { openid: 'oSomeoneElse', session_key: SESSION_KEY }
r = await run(good({ productId: 'monthly_test' }), {}, { PRO_TEST_OPENIDS: BOUND })
check('4.6 名单里只有账号那条 ⇒ 一致也照样拒（测试档认的就是这个 openid）', [r.status, r.body.code], [403, 'test_not_allowed'])

// ── 5. 前置⑤：续购窗口读的是 pro_coverage 那个整数 ──────────────────────────
reset()
stub.coverageBody = { is_covered: true, valid_until: '2026-11-01T15:59:59.999Z', remaining_days: 21 }
r = await run(good())
check('5.1 剩余 21 天 ⇒ 409 renew_window 且零写', [r.status, r.body.code, writes().length], [409, 'renew_window', 0])
check('5.2 文案是"还剩 N 天…可续购"＋"到期后可自由选档"整句（D-18 配套要求①）',
  r.body.error, '还剩 21 天，到期前 20 天内可续购；到期后可以自由选月卡或年卡。')
check('5.3 回包里带 remainingDays（端上不自己减）', r.body.remainingDays, 21)
reset()
stub.coverageBody = { is_covered: true, valid_until: '2026-10-24T15:59:59.999Z', remaining_days: 20 }
check('5.4 恰好 20 天算可买', (await run(good())).status, 200)
reset()
stub.coverageBody = { is_covered: false, valid_until: null, remaining_days: null }
check('5.5 从没买过（null）算可买（✅ E-7 维持 null 语义）', (await run(good())).status, 200)
reset()
stub.coverageBody = { is_covered: false, valid_until: '2026-01-01T15:59:59.999Z', remaining_days: -200 }
check('5.6 已到期（负数）算可买', (await run(good())).status, 200)
reset()
stub.coverageStatus = 503
r = await run(good())
check('5.7 判定查不到 ⇒ 503 拒单，零写', [r.status, r.body.code, writes().length], [503, 'pro_unavailable', 0])
reset()
stub.coverageBody = [{ is_covered: false }]
r = await run(good())
check('5.8 rpc 形状不对 ⇒ 同样 503（不静默当"没会员"放行）', [r.status, r.body.code], [503, 'pro_unavailable'])

// ── 6. 建单：行内容全部由服务端组装（6.2 铁律 3）─────────────────────────────
reset()
r = await run(good({ platform: 'ios' }))
const ins = calls.find((c) => c.method === 'POST' && c.url.includes('/rest/v1/pro_orders'))
check('6.1 插了一行 pending', [r.status, writes().length], [200, 1])
check('6.2 🔴 user_id 来自会话、不是请求体（请求里根本没有这个键）', ins.body.user_id, UID)
check('6.3 payer_openid ＝ 当场 code2session 的那个（反例判据 2）', ins.body.payer_openid, BOUND)
check('6.4 provider 锁 wechat_mp、buy_quantity 恒 1', [ins.body.provider, ins.body.buy_quantity], ['wechat_mp', 1])
check('6.5 金额取服务端表：选了安卓道具就是 333 分（🔴 跟着 productId 走，不跟端上上报的 platform 走）', ins.body.goods_price, 333)
check('6.6 env 落库是整数（PRO_ENV 字符串已折算）', [ins.body.env, typeof ins.body.env], [0, 'number'])
check('6.7 expires_at ＝ 现在 + 15 分钟', Math.round((Date.parse(ins.body.expires_at) - Date.now()) / 60000), 15)
check('6.8 attach ＝ 下单账号（4.2：推送回来可自证这单谁下的）', ins.body.attach, UID)
check('6.9 platform 落的是端上上报值（只作留痕，不参与任何判定）', ins.body.platform, 'ios')
check('6.10 unionid 有就带上（D-12；永不参与判定）', ins.body.payer_unionid, 'uBound')
reset()
r = await run(good({ platform: 'devtools' }))
check('6.11 上报值不在 CHECK 域里 ⇒ 折算成 unknown，不让库侧 23514 变成 500', insertCalls()[0].body.platform, 'unknown')
reset()
r = await run(good({ productId: 'yearly_mem_apple' }))
check('6.12 年卡按 id 取价（5990 分）与期限（365 天）', [r.body.goodsPrice, r.body.durationDays], [5990, 365])

// ── 7. 拉起参数：签名输入就是端上原样转交的那个字符串 ─────────────────────────
reset()
r = await run(good())
const insCall = insertCalls()[0]
const sd = r.body.pay.signData
const parsed = JSON.parse(sd)
check('7.1 pay 只有 mode／signData／paySig／signature 四样', Object.keys(r.body.pay).sort(), ['mode', 'paySig', 'signData', 'signature'])
check('7.2 🔴 signData 是**字符串**（官方页：JSON 字符串），不是对象', typeof sd, 'string')
check('7.3 键序固定为签名输入那七件套', Object.keys(parsed).join(','), 'offerId,buyQuantity,env,currencyType,productId,goodsPrice,outTradeNo,attach')
check('7.4 mode 固定 short_series_goods、env 恒 0、buyQuantity 恒 1', [parsed.mode, r.body.pay.mode, parsed.env, parsed.buyQuantity], [undefined, 'short_series_goods', 0, 1])
check('7.5 paySig ＝ HMAC(AppKey, "requestVirtualPayment&"+signData)', r.body.pay.paySig, expectHmac('appkey-1', `requestVirtualPayment&${sd}`))
check('7.6 signature ＝ HMAC(session_key, signData)（同一条字符串）', r.body.pay.signature, expectHmac(SESSION_KEY, sd))
check('7.7 单号形如 T+13 位毫秒+8 位 hex，且落库与签出去是同一个', [/^T\d{13}[0-9a-f]{8}$/.test(r.body.outTradeNo), parsed.outTradeNo === r.body.outTradeNo, insCall.body.out_trade_no === r.body.outTradeNo], [true, true, true])
reset()
r = await run(good())
check('7.8 🔴 响应体里搜不到 session_key 的任何一段', JSON.stringify(r.body).includes(SESSION_KEY.slice(0, 10)), false)
check('7.9 响应体里没有 openid（4.6）', JSON.stringify(r.body).includes(BOUND), false)
check('7.10 reused:false', r.body.reused, false)

// ── 8. 前置④状态机（✅ E-21 判乙：复用＝形状对 **且** 平台答"还开着"）──────────
const pendingRow = (over = {}) => ({
  out_trade_no: 'T1727000000000deadbeef',
  payer_openid: BOUND,
  product_id: 'monthly_mem_android',
  goods_price: 333,
  env: 0,
  status: 'pending',
  expires_at: future(),
  attach: UID,
  ...over,
})
const queryCalls = () => calls.filter((c) => c.url.includes('/xpay/query_order'))
const PAID_BODY = { errcode: 0, errmsg: 'ok', order: { status: 2, paid_time: 1790000000, wx_order_id: 'wx-1' } }
const UNPAID_BODY = { errcode: 0, errmsg: 'ok', order: { status: 1 } } // 平台侧"还开着"
const CLOSED_BODY = { errcode: 0, errmsg: 'ok', order: { status: 6 } } // 平台侧"已关闭"（探针实测：取消后 ~10 秒）

reset()
stub.pendingRows = [pendingRow()]
stub.queryBody = UNPAID_BODY
r = await run(good())
check('8.1 同商品同 env 未过期＋平台说还开着 ⇒ 复用原单，不再插、不关', [r.body.reused, r.body.outTradeNo, insertCalls().length, patchCalls().length], [true, 'T1727000000000deadbeef', 0, 0])
check('8.1b 🔴 复用之前**必须问过平台**（E-21 判乙的全部代价＝这一格从 0 变 1）', queryCalls().length, 1)
const sd2 = JSON.parse(r.body.pay.signData)
check('8.2 复用也重签一次（session_key 是新的，签名必须贴着这一刻算）', [sd2.outTradeNo, r.body.pay.signature], ['T1727000000000deadbeef', expectHmac(SESSION_KEY, r.body.pay.signData)])
check('8.3 金额取**订单行里的值**，不重新读价格表', sd2.goodsPrice, 333)

// 🔴 8.4–8.13 是 **B3-3 恢复后的前置④**：不能复用 ⇒ 先查单，查得"未付/查无/已关"才关旧建新。
//   这一族格子的牙齿有两处：① `queryCalls()===1`（**没查过就不许关**——E-14 判乙时的那条边界
//   现在换成"查过才动"，仍然是同一件事：不许拿"我方口径的关闭"去赌"这单没被付"）；
//   ② 查单说已付那一支必须**零写库**（既不关也不建，也不能在这里入账）。

reset()
stub.pendingRows = [pendingRow({ product_id: 'yearly_mem_android' })]
r = await run(good())
check('8.4 换档＋查得查无此单 ⇒ 关旧建新（E-14 的那条拒单已随 B3-3 撤销）', [r.status, r.body.reused, queryCalls().length, patchCalls().length, insertCalls().length], [200, false, 1, 1, 1])
check('8.4b 🔴 查单打的正是那张旧单号与它的 payer_openid', queryCalls()[0].body.order_id, 'T1727000000000deadbeef')
check('8.4c 查单 body 带 openid（接口必填）与 env', [queryCalls()[0].body.openid, queryCalls()[0].body.env], [BOUND, 0])
check('8.4d PATCH 的过滤条件带 status=eq.pending（撞车时不会把已付单改回未付）', patchCalls()[0].url.includes('status=eq.pending'), true)
check('8.4e 新单是新单号', r.body.outTradeNo !== 'T1727000000000deadbeef', true)

reset()
stub.pendingRows = [pendingRow({ product_id: 'yearly_mem_android' })]
stub.queryBody = PAID_BODY
r = await run(good())
check('8.5 换档但平台说上一笔已付 ⇒ 409 previous_order_paid', [r.status, r.body.code], [409, 'previous_order_paid'])
check('8.5b 🔴 零写库：不关旧单、不建新单、也不在这里入账', [patchCalls().length, insertCalls().length], [0, 0])
check('8.5c 把旧单号回给端上（让轮询去确认它，入账不在下单侧做）', r.body.orderNo, 'T1727000000000deadbeef')

reset()
stub.pendingRows = [pendingRow({ product_id: 'yearly_mem_android' })]
stub.queryBody = { errcode: 0, errmsg: 'ok', order: { status: 5 } }
r = await run(good())
check('8.5d ✅ E-17 判丙：平台说已退款 ⇒ 旧单标 anomaly 后**放行新单**（不再 409 把人永久挡死）', [r.status, r.body.reused, queryCalls().length, patchCalls().length, insertCalls().length], [200, false, 1, 1, 1])
check('8.5e 🔴 标的值是 anomaly + refunded_not_credited，绝不是 closed（closed 的语义是"没付过"）', [bodyAt(patchCalls()).status, bodyAt(patchCalls()).anomaly_reason], ['anomaly', 'refunded_not_credited'])
check('8.5f 留痕写进 note（A3 巡检那一条要能看出这是谁、为什么）', String(bodyAt(patchCalls()).note).includes('未入账'), true)
check('8.5g 与关旧建新同一条过滤：status=eq.pending（撞车时匹配 0 行，不改已付单）', urlAt(patchCalls()).includes('status=eq.pending'), true)
check('8.5h 🔴 这一支不许出现第二次写、更不许出现 status:closed（先标 anomaly 再关＝两个互相矛盾的状态）', [patchCalls().length, patchCalls().some((c) => c.body && c.body.status === 'closed')], [1, false])
reset()
stub.pendingRows = [pendingRow({ product_id: 'yearly_mem_android' })]
stub.queryBody = { errcode: 0, errmsg: 'ok', order: { status: 5 } }
stub.patchStatus = 500
r = await run(good())
check('8.5i 🔴 标 anomaly 失败 ⇒ 503 且**不建新单**（旧单还是 pending，partial unique 会把它挡下来；先改旧再建新不是"顺手记一笔"）', [r.status, r.body.code, insertCalls().length], [503, 'pro_unavailable', 0])

reset()
stub.pendingRows = [pendingRow({ product_id: 'yearly_mem_android' })]
stub.queryBody = { errcode: 268490003, errmsg: '签名错误' }
r = await run(good())
check('8.6 🔴 查单本身失败 ⇒ 503 且零写（没查到不等于没付）', [r.status, r.body.code, patchCalls().length, insertCalls().length], [503, 'pro_unavailable', 0, 0])

reset()
stub.pendingRows = [pendingRow({ product_id: 'yearly_mem_android' })]
stub.queryBody = { errcode: 0, errmsg: 'ok', order: { status: 99 } }
r = await run(good())
check('8.6b 🔴 平台回了个**没见过**的 status ⇒ 同样 503 零写。这一格钉的是归类表里最贵的一格：把"没读懂"归进"未付"，就会把一张可能已付的单 closed 掉', [r.status, r.body.code, patchCalls().length, insertCalls().length], [503, 'pro_unavailable', 0, 0])

reset()
stub.queryBody = UNPAID_BODY
stub.pendingRows = [pendingRow({ expires_at: past() })]
r = await run(good())
check('8.7 同档但已超 expires_at＋查得未付 ⇒ 关旧建新（✅ 判乙那条"取消满 15 分钟买不了"已解除）', [r.status, queryCalls().length, patchCalls().length, insertCalls().length], [200, 1, 1, 1])

reset()
stub.pendingRows = [pendingRow({ env: 1 })]
r = await run(good())
check('8.8 同档但 env 不同 ⇒ 不复用（4.2：沙箱单不能当成现网单）', [r.body.reused, patchCalls().length], [false, 1])

reset()
stub.pendingRows = [pendingRow({ expires_at: 'not-a-date' })]
r = await run(good())
check('8.9 行里读不出 expires_at ⇒ 按已过期处理（宁可关旧建新，也不复用一张不确定有效期的单）', patchCalls().length, 1)

// 🔴 8.10–8.12 是 E-21 判乙换进来的三格。原来那格"能复用时不打查单（省一次对外调用）"
//   已经被**反向**了：省下来的那一次调用，代价是把一个已死单号发给用户（探针实测取消后
//   平台 10 秒就关单）。判据的方向因此从"少打一次"改成"没问过平台就不许说复用"。
reset()
stub.pendingRows = [pendingRow()]
stub.queryBody = CLOSED_BODY
r = await run(good())
check('8.10 🔴 形状全对（同档同 env 未过期）但平台答"已关闭" ⇒ **不复用**，关旧建新（新单号）', [r.body.reused, r.body.outTradeNo !== 'T1727000000000deadbeef', queryCalls().length, patchCalls().length, insertCalls().length], [false, true, 1, 1, 1])

reset()
stub.pendingRows = [pendingRow({ product_id: 'yearly_mem_android' })]
stub.queryBody = UNPAID_BODY
r = await run(good())
check('8.11 平台说"还开着"但形状不对（换档）⇒ 照样关旧建新（复用只在两件事同时成立时发生）', [r.body.reused, patchCalls().length, insertCalls().length], [false, 1, 1])

reset()
stub.pendingRows = [pendingRow()]
stub.queryBody = { errcode: 268490003, errmsg: '签名错误' }
r = await run(good())
check('8.12 🔴 形状全对＋查单判不出 ⇒ 503、零写、**也不复用**（旧代码在这里会直接复用那张单；把"不知道"当"还开着"就是 E-21 要堵的那个洞）', [r.status, r.body.code, r.body.reused, queryCalls().length, writes().length], [503, 'pro_unavailable', undefined, 1, 0])

reset()
stub.pendingStatus = 500
r = await run(good())
check('8.13 pending 查不到 ⇒ 503 拒、零写（不"当没有单"直接建）', [r.status, r.body.code, writes().length], [503, 'pro_unavailable', 0])

// ── 9. 库侧 partial unique index 挡双击 ────────────────────────────────────
reset()
stub.insertStatus = 409
stub.insertError = { code: '23505', message: 'duplicate key value violates unique constraint "pro_orders_one_pending_per_openid"' }
stub.pendingRows = [pendingRow()] // 并发另一下已经把它落库了 ⇒ 重读就读得到
r = await run(good())
check('9.1 撞"一人一张 pending"⇒ 重读到那张并复用，不当故障报', [r.status, r.body.reused, r.body.outTradeNo], [200, true, 'T1727000000000deadbeef'])
reset()
stub.insertStatus = 409
stub.insertError = { code: '23505', message: 'duplicate key value violates unique constraint "pro_orders_one_pending_per_openid"' }
stub.pendingRows = []
r = await run(good())
check('9.2 重读却是空 ⇒ 409 pending_order_open（不假装成功）', [r.status, r.body.code], [409, 'pending_order_open'])
reset()
stub.insertStatus = 409
stub.insertError = { code: '23505', message: 'duplicate key value violates unique constraint "pro_orders_out_trade_no_key"' }
r = await run(good())
check('9.3 撞单号 ⇒ 503 order_no_collision（并发同毫秒，理论极低但要能识别）', [r.status, r.body.code], [503, 'order_no_collision'])
reset()
stub.insertStatus = 400
stub.insertError = { code: '23514', message: 'new row violates check constraint' }
r = await run(good())
check('9.4 其它插入失败 ⇒ 503 pro_unavailable，不返回半套支付参数', [r.status, r.body.code, r.body.pay], [503, 'pro_unavailable', undefined])

// ── 10. 订单页只读面（GET）：按 openid 查、只回白名单列 ───────────────────────
const getCtx = (eover = {}, user = { user: { id: UID } }) => ({ env: env(eover), data: user, request: new Request('https://cf/api/pro/orders') })
reset()
r = await onRequestGet(getCtx())
check('10.1 没有任何单 ⇒ 空列表 + purchaseEnabled:true', [r.status, await r.json().then((b) => [b.purchaseEnabled, b.orders])], [200, [true, []]])

reset()
stub.pendingRows = [{ out_trade_no: 'T1727000000000000000000aa', product_id: 'monthly_mem_android', goods_price: 333, currency_type: 'CNY', env: 0, status: 'paid', paid_at: '2026-10-04T09:00:00Z', created_at: '2026-10-04T09:00:00Z', expires_at: '2026-10-04T09:15:00Z' }]
let gb = await (await onRequestGet(getCtx())).json()
check('10.2 已付单出得来：名字/金额/期限从服务端表补', [gb.orders.length, gb.orders[0].name, gb.orders[0].goodsPrice, gb.orders[0].durationDays, gb.orders[0].status], [1, 'Handle 会员 · 月卡', 333, 30, 'paid'])
const listUrl = calls.find((c) => c.url.includes('/rest/v1/pro_orders')).url
// 🔴 4.7 那句"订单页按付款微信看、不看 user_id"在这里是**可执行的**：漏了 openid 条件，
//    返回的是"读这个人此刻绑着的微信名下的单"——同一个人不会少看自己的单，所以症状是静默的；
//    真出事在"访客买完合并进邮箱"那一格（`user_id` 指向已删的访客行 ⇒ 订单页变空）。
check('10.3 查询带 payer_openid＋provider，🔴 不带 user_id', [listUrl.includes('payer_openid=eq.' + BOUND), listUrl.includes('provider=eq.wechat_mp'), listUrl.includes('user_id=eq.')], [true, true, false])
// 🔴 10.4 原来钉的是 **select 列**，而 `payer_openid` 是退款资格判据的输入（`evaluateRefund` 拿它比
//   归属）——把它挡在 select 外面，端点就永远算出 `refundable:false`，订单页那颗按钮永远不出现
//   （2026-10-05 真机撞到的正是这一条，而这一格当时是绿的）。白名单**从来都是响应侧**的事，
//   所以判据挪到这里：读得到不等于回得出。
const FORBIDDEN_KEYS = ['payer_openid', 'callback_raw', 'note', 'operator', 'attach', 'user_id', 'payer_unionid']
check('10.4 🔴 响应体的每一行里不许出现这些键（select 读得到 ≠ 回得出，白名单钉在响应上）',
  Object.keys(gb.orders[0]).filter((k) => FORBIDDEN_KEYS.includes(k)), [])
// 🔴 这一格是 10.4 改口径之后**补上的牙**：静态要求"资格函数读的每一个 `row.X` 都在这条 select 里"。
//   打桩喂的行是手写的，漏列这种事在桩里看不出来；只有把两份源码对起来才抓得住"生产者没喂、消费者在读"。
{
  const refundSrc = readFileSync(path.join(root, 'functions/_lib/proRefund.js'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const selectCols = listSelectColumns()
  const needs = [...new Set([...refundSrc.matchAll(/\brow\.([a-z_0-9]+)/g)].map((x) => x[1]))]
  check('10.4b 🔴 `evaluateRefund` 读的每个 `row.X` 必须在列表 select 的列里（缺一个＝按钮恒不出现）',
    [needs.slice().sort(), needs.filter((c) => !selectCols.includes(c)).sort()],
    [['env', 'id', 'is_duplicate', 'paid_at', 'payer_openid', 'platform', 'status'], []])
}
check('10.5 响应体里也搜不到 openid 与 unionid', [JSON.stringify(gb).includes(BOUND), JSON.stringify(gb).includes('uBound')], [false, false])
reset()
gb = await (await onRequestGet(getCtx({}, {}))).json().catch(() => null)
check('10.6 没有会话身份 ⇒ 401', (await onRequestGet({ env: env(), data: {}, request: new Request('https://cf/api/pro/orders') })).status, 401)
reset()
gb = await (await onRequestGet(getCtx({ PRO_PURCHASE_ENABLED: 'false' }))).json()
check('10.7 入口关着 ⇒ 空列表且零次数据库', [gb.purchaseEnabled, gb.orders.length, calls.length], [false, 0, 0])
reset()
stub.identityRows = []
gb = await (await onRequestGet(getCtx())).json()
check('10.8 账号没绑微信 ⇒ 空列表（不是"全部订单"，也不是报错）＋ 🔴 必须说得出"是没绑"（E-26 甲：旧形状与"你没买过"同形，会诱导人再买一笔）', [gb.orders.length, gb.noWechatBinding, gb.listUnavailable, calls.filter((c) => c.url.includes('/rest/v1/pro_orders')).length], [0, true, undefined, 0])
reset()
stub.identityStatus = 500
gb = await (await onRequestGet(getCtx())).json()
check('10.9 identity 读失败 ⇒ 200 + 空列表（读侧收紧方向同 products），🔴 但标的是 `listUnavailable` 而不是"没绑"（两种失败的用户动作不同：等一会儿 vs 去绑定）', [gb.purchaseEnabled, gb.orders.length, gb.listUnavailable, gb.noWechatBinding], [true, 0, true, undefined])
reset()
gb = await (await onRequestGet(getCtx())).json()
check('10.9b 🔴 正常路径两个标记都不许出现（恒真的标记＝没有标记：那等于把"你没买过"重新说成一句空话）', [gb.noWechatBinding === undefined, gb.listUnavailable === undefined], [true, true])
reset()
stub.pendingStatus = 500
r = await onRequestGet(getCtx())
check('10.10 列表查询失败 ⇒ 503 结构化，不返回半截列表', [r.status, (await r.json()).code], [503, 'pro_unavailable'])
reset()
stub.pendingRows = [{ out_trade_no: 'T1', product_id: 'discontinued_item', goods_price: 100, currency_type: 'CNY', env: 0, status: 'closed', paid_at: null, created_at: 'x', expires_at: 'y' }]
gb = await (await onRequestGet(getCtx())).json()
check('10.11 道具已从表里撤下 ⇒ 名字退回 id、期限为 null，钱仍然看得见', [gb.orders[0].name, gb.orders[0].durationDays, gb.orders[0].goodsPrice], ['discontinued_item', null, 100])

// ── 10.12…10.15 那颗「申请退款」按钮的**行为**判据（原来整段都没算过一次 refundable，见 10.4 那段）──
// 🔴 把桩里的行**按生产者的 select 裁一遍**：这样 select 漏列时 10.12 会跟着红（不然打桩喂的
//   手写行永远带着那一列，就又是"判据绿着、按钮不存在"——2026-10-05 那次翻车的根因形状）。
const asProductionRow = (row) => {
  const cols = listSelectColumns()
  const out = {}
  for (const k of Object.keys(row)) if (cols.includes(k)) out[k] = row[k]
  return out
}
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString()
const refundableRow = (over = {}) => ({
  id: 'ord-1',
  out_trade_no: 'T1727000000000000000000rb',
  product_id: 'pro_test_day',
  goods_price: 1,
  currency_type: 'CNY',
  env: 0,
  status: 'paid',
  paid_at: hoursAgo(2),
  created_at: hoursAgo(2),
  expires_at: hoursAgo(2),
  platform: 'android',
  is_duplicate: false,
  payer_openid: BOUND,
  ...over,
})
reset()
stub.pendingRows = [asProductionRow(refundableRow())]
gb = await (await onRequestGet(getCtx())).json()
check('10.12 🔴 已付、现网、2 小时前、这个微信没用过额度 ⇒ 列表把 `refundable` 算成 true（按钮的唯一判据）',
  [gb.refundInfoUnavailable, gb.orders[0].refundable, gb.orders[0].refundStatus], [false, true, 'none'])

reset()
stub.pendingRows = [asProductionRow(refundableRow())]
stub.refundRows = [{ order_id: 'ord-1', kind: 'no_reason', status: 'pending', requested_at: hoursAgo(1), executed_at: null, note: null }]
gb = await (await onRequestGet(getCtx())).json()
check('10.13 已经申请过（pending）⇒ 进度看得见、按钮不能再点（6.1 ⑦＋额度只一次）',
  [gb.orders[0].refundStatus, gb.orders[0].refundable], ['pending', false])

reset()
stub.pendingRows = [asProductionRow(refundableRow())]
stub.refundRows = [{ order_id: 'ord-1', kind: 'no_reason', status: 'rejected', requested_at: hoursAgo(1), executed_at: null, note: null }]
gb = await (await onRequestGet(getCtx())).json()
check('10.14 被拒过 ⇒ 额度归还 ⇒ 又能申请（#68 后半的那道额度账）', [gb.orders[0].refundStatus, gb.orders[0].refundable], ['rejected', true])

reset()
stub.pendingRows = [refundableRow({ payer_openid: undefined })] // 反向复现：生产者漏喂这一列
gb = await (await onRequestGet(getCtx())).json()
check('10.15 🔴 反向复现：select 少给 `payer_openid` ⇒ refundable 必须当场变 false（证明 10.12 不是恒真）',
  gb.orders[0].refundable, false)

reset()
stub.pendingRows = [asProductionRow(refundableRow())]
stub.refundStatus = 500
gb = await (await onRequestGet(getCtx())).json()
check('10.16 申请行读不到 ⇒ `refundInfoUnavailable:true` 且每行 refundable 收着 false（读不到不许画成"能退"）',
  [gb.refundInfoUnavailable, gb.orders[0].refundable], [true, false])

// ── 11. 静态门：写面收敛与开关只读部署变量 ─────────────────────────────────

function stripComments(src) {
  let out = ''
  let i = 0
  let str = null
  while (i < src.length) {
    const c = src[i]
    if (str) {
      out += c
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue }
      if (c === str) str = null
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') { str = c; out += c; i++; continue }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; out += ' '; continue }
    out += c
    i++
  }
  return out
}
const files = []
function collect(dir, out = files) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) collect(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}
collect(path.join(root, 'functions'))
const codeOf = new Map(files.map((f) => [f, stripComments(readFileSync(f, 'utf8'))]))
const rel = (f) => path.relative(root, f).replace(/\\/g, '/')
const hits = (re) => files.filter((f) => re.test(codeOf.get(f))).map(rel)

check('11.1 🔴 三张会员表的 REST 面只在 proStore.js（4.6"写这三张表的模块只有一个"）', hits(/rest\/v1\/pro_orders|rest\/v1\/pro_ledger|rest\/v1\/pro_refund_requests/), ['functions/_lib/proStore.js'])
check('11.2 开关标识符仍只在 proCoverage.js（端点走 readProFlags）', hits(/PRO_WALLS_ENABLED|PRO_PURCHASE_ENABLED/), ['functions/_lib/proCoverage.js'])
check('11.3 没有任何端点从请求里读开关或金额', hits(/searchParams\.get\(\s*['"](PRO_|wallsEnabled|purchase|goodsPrice|price)|headers\.get\(\s*['"]x-pro/i), [])
check('11.4 判据只经 proCoverage（rpc 调用点仍唯一）', hits(/rpc\/pro_coverage/), ['functions/_lib/proCoverage.js'])
// ✅ 剥注释扫出来的结果比原期望更严：`wxTicket.js` 只在**注释**里提过 session_key
//   （它的 code2session 刻意不返回这一把），所以代码里真拿着它的只有签名模块一个文件。
check('11.5 session_key 这个标识符只活在 proPaySign.js 里（下单端点只透传 sessionKey 变量名）', hits(/session_key/), ['functions/_lib/proPaySign.js'])
check('11.6 折叠算法没有第二处 JS 实现', hits(/prev_last_day|day_start|end_excl/), [])
// 🔴 路由形状也算判据：Pages Functions 里 `orders.js` 与 `orders/index.js` 会争同一个路径，
//   谁赢没有文档背书 ⇒ 同一路径的 GET/POST 必须待在**同一个文件**里（现在就是），
//   而目录式路由下不能再出现同名的扁平文件。
const orderRoutes = files.filter((f) => /functions\/api\/pro\/orders(\.js|\/index\.js)$/.test(f.replace(/\\/g, '/'))).map(rel)
check('11.7 /api/pro/orders 只有一份路由文件（GET 与 POST 同在 orders/index.js）', orderRoutes, ['functions/api/pro/orders/index.js'])
// 🔴 这一条是 E-14 判乙的**代码面**：查单没落地 ⇒ 今天全仓不许有任何一处把订单写成 `closed`。
//   为什么单独钉一条静态门：拒单那三行迟早会被"顺手改成关旧建新"（那是判甲的写法），
//   而改的人不会先读 §十六——静态门会在当场响，比留一句注释可靠。
// 🔴 这一格原来是"全仓不许出现把订单写成 closed 的代码"（E-14 判乙时的闸门）。B3-3 恢复了
//   "查得未付 ⇒ 关旧建新"，所以那条**边界换成了下面这条更准的**：关单只许发生在带
//   `status=eq.pending` 的那一条 PATCH 上（否则撞上推送就把已付单改回未付），且调用点只有一个。
//   记在这里是因为"撤一条门"必须写清换成了什么，不然下一个人只会看到门不见了。
const closePatchSites = files.filter((f) => /status=eq\.pending/.test(codeOf.get(f)) && /'closed'/.test(codeOf.get(f))).map(rel)
check('11.8 关旧单只发生在带 status=eq.pending 的 PATCH 上，且只有一个实现处', closePatchSites, ['functions/_lib/proStore.js'])
const closeCallers = files.filter((f) => /closePendingOrder/.test(codeOf.get(f))).map(rel).sort()
check('11.8b closePendingOrder 的调用点只有下单端点（推送侧接上时在这里加第二个）', closeCallers, ['functions/_lib/proStore.js', 'functions/api/pro/orders/index.js'])

let fails = 0
for (const x of results) {
  if (!x.ok) {
    fails++
    console.log(`❌ ${x.name}\n   got : ${JSON.stringify(x.got)}\n   want: ${JSON.stringify(x.want)}`)
  }
}
console.log(`\n${results.length - fails}/${results.length} 格通过`)
process.exit(fails ? 1 : 0)
