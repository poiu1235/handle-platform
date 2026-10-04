// B3-2 下单端点的离线判据：跑**真源码** functions/api/pro/orders.js（fetch 打桩成假 Supabase
// 与假 code2session）。
// 用法：npm run test:orders
//
// 为什么能这么跑：这个端点只用 fetch ＋ Web Crypto（crypto.subtle），没有 workerd 专有 API。
// 这台机器到 *.supabase.co / api.weixin.qq.com 的 TLS 被 SNI 重置 ⇒ 真链路只能部署后测，
// 但**七条前置的顺序、状态机、签名的输入**这三件事在本地就能判死——
// 尤其是"前置②没过不许有任何写动作"这一条，只有打桩能看到"几次 PATCH/POST"。
//
// ⚠️ 它证明不了的：微信是否接受这个 signData 字符串（R-9）、道具是否已在后台发布且价格逐字一致
//   （不一致的症状是拉起被平台拒）、`/pay/query` 那一路能不能把货发出去（B3-3 阻塞在 R-9 ①）、
//   以及真机上 `wx.login` 的 code 与 Bearer 会话是否同一微信号（那是验收 #26/#36 的活）。

import crypto from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const results = []
const check = (name, got, want) => results.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want })
const expectHmac = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex')

const { onRequestPost } = await import(pathToFileURL(path.join(root, 'functions/api/pro/orders.js')).href)

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
  wxBody: { openid: BOUND, session_key: SESSION_KEY, unionid: 'uBound' },
  wxOk: true,
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
  if (u.includes('/rest/v1/rpc/pro_coverage')) return mk(stub.coverageBody, stub.coverageStatus)
  if (u.includes('/rest/v1/user_identities')) return mk(stub.identityRows, stub.identityStatus)
  if (u.includes('/rest/v1/pending_deletions')) return mk(stub.pdelRows, stub.pdelStatus)
  if (u.includes('/rest/v1/pro_orders') && method === 'POST') {
    if (stub.insertStatus !== 201) return mk(stub.insertError || { message: 'insert boom' }, stub.insertStatus)
    return mk({}, 201)
  }
  if (u.includes('/rest/v1/pro_orders') && method === 'PATCH') return mk({}, stub.patchStatus)
  if (u.includes('/rest/v1/pro_orders')) {
    if (stub.pendingStatus !== 200) return mk({ message: 'select boom' }, stub.pendingStatus)
    return mk(stub.pendingRows)
  }
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
const insertCalls = () => calls.filter((c) => c.url.includes('/rest/v1/pro_orders') && c.method === 'POST')
const patchCalls = () => calls.filter((c) => c.url.includes('/rest/v1/pro_orders') && c.method === 'PATCH')
const codeConsumed = () => calls.filter((c) => c.url.includes('jscode2session')).length

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

// ── 8. 前置④状态机：同档同 env 未过期才复用 ─────────────────────────────────
const pendingRow = (over = {}) => ({
  out_trade_no: 'T1727000000000deadbeef',
  product_id: 'monthly_mem_android',
  goods_price: 333,
  env: 0,
  status: 'pending',
  expires_at: future(),
  attach: UID,
  ...over,
})
reset()
stub.pendingRows = [pendingRow()]
r = await run(good())
check('8.1 同商品同 env 未过期 ⇒ 复用原单，不再插、不关', [r.body.reused, r.body.outTradeNo, insertCalls().length, patchCalls().length], [true, 'T1727000000000deadbeef', 0, 0])
const sd2 = JSON.parse(r.body.pay.signData)
check('8.2 复用也重签一次（session_key 是新的，签名必须贴着这一刻算）', [sd2.outTradeNo, r.body.pay.signature], ['T1727000000000deadbeef', expectHmac(SESSION_KEY, r.body.pay.signData)])
check('8.3 金额取**订单行里的值**，不重新读价格表', sd2.goodsPrice, 333)

reset()
stub.pendingRows = [pendingRow({ product_id: 'yearly_mem_android' })]
r = await run(good())
check('8.4 🔴 换档 ⇒ 先把旧单置 closed 再新建（4.5 收窄版，月卡 pending 期能改买年卡）', [patchCalls().length, insertCalls().length, r.body.reused], [1, 1, false])
check('8.5 PATCH 的过滤条件带 status=eq.pending（撞车时不会把已付单改回未付）', patchCalls()[0].url.includes('status=eq.pending'), true)
check('8.6 新单是新单号（不复用换档那张的 out_trade_no）', r.body.outTradeNo !== 'T1727000000000deadbeef', true)

reset()
stub.pendingRows = [pendingRow({ expires_at: past() })]
r = await run(good())
check('8.7 同档但已超 expires_at ⇒ 关旧建新（🔴 不押"同单号能否二次拉起"＝R-9 ⑩）', [patchCalls().length, r.body.reused], [1, false])

reset()
stub.pendingRows = [pendingRow({ env: 1 })]
r = await run(good())
check('8.8 同档但 env 不同 ⇒ 不复用（4.2：沙箱单不能当成现网单）', r.body.reused, false)

reset()
stub.pendingRows = [pendingRow({ expires_at: 'not-a-date' })]
r = await run(good())
check('8.9 行里读不出 expires_at ⇒ 按已过期处理（更严的一侧）', patchCalls().length, 1)

reset()
stub.pendingStatus = 500
r = await run(good())
check('8.10 pending 查不到 ⇒ 503 拒、零写（不"当没有单"直接建）', [r.status, r.body.code, writes().length], [503, 'pro_unavailable', 0])

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

// ── 10. 静态门：写面收敛与开关只读部署变量 ─────────────────────────────────
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

check('10.1 🔴 三张会员表的 REST 面只在 proStore.js（4.6"写这三张表的模块只有一个"）', hits(/rest\/v1\/pro_orders|rest\/v1\/pro_ledger|rest\/v1\/pro_refund_requests/), ['functions/_lib/proStore.js'])
check('10.2 开关标识符仍只在 proCoverage.js（端点走 readProFlags）', hits(/PRO_WALLS_ENABLED|PRO_PURCHASE_ENABLED/), ['functions/_lib/proCoverage.js'])
check('10.3 没有任何端点从请求里读开关或金额', hits(/searchParams\.get\(\s*['"](PRO_|wallsEnabled|purchase|goodsPrice|price)|headers\.get\(\s*['"]x-pro/i), [])
check('10.4 判据只经 proCoverage（rpc 调用点仍唯一）', hits(/rpc\/pro_coverage/), ['functions/_lib/proCoverage.js'])
// ✅ 剥注释扫出来的结果比原期望更严：`wxTicket.js` 只在**注释**里提过 session_key
//   （它的 code2session 刻意不返回这一把），所以代码里真拿着它的只有签名模块一个文件。
check('10.5 session_key 这个标识符只活在 proPaySign.js 里（下单端点只透传 sessionKey 变量名）', hits(/session_key/), ['functions/_lib/proPaySign.js'])
check('10.6 折叠算法没有第二处 JS 实现', hits(/prev_last_day|day_start|end_excl/), [])

let fails = 0
for (const x of results) {
  if (!x.ok) {
    fails++
    console.log(`❌ ${x.name}\n   got : ${JSON.stringify(x.got)}\n   want: ${JSON.stringify(x.want)}`)
  }
}
console.log(`\n${results.length - fails}/${results.length} 格通过`)
process.exit(fails ? 1 : 0)
