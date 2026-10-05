// 入站推送接收器的离线判据：跑**真源码** `functions/push/xpay.js` ＋ `_lib/proPush.js`
// （fetch 打桩成假 Supabase、假 token、假 query_order、假 notify_provide_goods）。
// 用法：npm run test:push
//
// 这一份为什么必须存在：这条通道是**公网可达、无用户态凭证**的入站口，它同时握着两件事——
// "要不要处理这条请求"（验签）与"平台该不该继续重推"（应答码）。两样都判错的时候症状是静默的：
// 放过坏签名＝任何人可入账，应答 ErrCode 0 于"还没查到"＝亲手关掉四层兜底的第①层（平台不再重推）。
// 所以本文件的重点不是"能不能处理"，而是**哪些情况下它必须什么都不写**。
//
// ⚠️ 它证明不了的：真推来的事件名与字段名是不是我们读的这两个（`xpay_goods_deliver_notify` 只有
//   工程稿给过 ⇒ R-9 ⑥；第一次真推的取证格＝验收 #73①），以及平台对非 0 应答到底重推几次
//   （那句"15 次"来自个人版页的工具抓取）。
import path from 'node:path'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const results = []
const check = (name, got, want) => results.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want })

const { onRequestGet, onRequestPost } = await import(pathToFileURL(path.join(root, 'functions/push/xpay.js')).href)
const { creditOrder, refundOrder } = await import(pathToFileURL(path.join(root, 'functions/_lib/proCredit.js')).href)
const { verifyPushSignature, readPushFields } = await import(pathToFileURL(path.join(root, 'functions/_lib/proPush.js')).href)

const TOKEN = 'TestToken123'
const NO = 'T1791182263204cfc1e485'
const OID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OPENID = 'ob9w-3fSO7EjTCQTM2JyHacr2RsU'
const UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PAID_SEC = 1791182274
const PAID_ISO = new Date(PAID_SEC * 1000).toISOString()

// ── 假后端 ─────────────────────────────────────────────────────────────────
let calls = []
let stub = {}
const orderRow = (over = {}) => ({
  id: OID,
  user_id: UID,
  provider: 'wechat_mp',
  payer_openid: OPENID,
  out_trade_no: NO,
  product_id: 'monthly_mem_android',
  goods_price: 333,
  currency_type: 'CNY',
  env: 0,
  buy_quantity: 1,
  status: 'pending',
  paid_at: null,
  wx_order_id: null,
  wxpay_order_id: null,
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 600_000).toISOString(),
  is_duplicate: false,
  paid_after_close: false,
  ...over,
})
const defaultStub = () => ({
  orderRow: orderRow(),
  orderRows: null,
  ledgerRows: [],
  ledgerRevokeRows: [{ id: 'l-1' }], // 撤账那次 PATCH 回几行（0 行＝之前已撤过）
  patchRows: [{ out_trade_no: NO, status: 'paid' }],
  refundedPatchRows: [{ out_trade_no: NO, status: 'refunded' }],
  queryBody: { errcode: 0, errmsg: 'ok', order: { status: 3, paid_time: PAID_SEC, wx_order_id: 'VPO-1', wxpay_order_id: '4500-1' } },
  notifyBody: { errcode: 0, errmsg: 'OK' },
  tokenBody: { access_token: 'TOKEN-x', expires_in: 7200 },
  coverageBody: { is_covered: false, valid_until: null, remaining_days: null },
  pushToken: TOKEN,
})
const reset = () => {
  calls = []
  stub = defaultStub()
}

globalThis.fetch = async (url, options) => {
  const u = String(url)
  const method = (options && options.method) || 'GET'
  const body = options && options.body ? JSON.parse(options.body) : null
  calls.push({ url: u, method, body, headers: (options && options.headers) || {} })
  const mk = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
  if (u.includes('cgi-bin/token')) return mk(stub.tokenBody)
  if (u.includes('/xpay/query_order')) return mk(stub.queryBody)
  if (u.includes('/xpay/notify_provide_goods')) return mk(stub.notifyBody)
  if (u.includes('/rpc/pro_coverage')) return mk(stub.coverageBody)
  if (u.includes('/rest/v1/pro_ledger') && method === 'PATCH') {
    return mk(stub.ledgerRevokeRows, 200)
  }
  if (u.includes('/rest/v1/pro_ledger') && method === 'POST') return mk({}, 201)
  if (u.includes('/rest/v1/pro_ledger')) return mk(stub.ledgerRows)
  if (u.includes('/rest/v1/pro_orders') && method === 'PATCH') {
    return mk(body && body.status === 'refunded' ? stub.refundedPatchRows : stub.patchRows, 200)
  }
  if (u.includes('/rest/v1/pro_orders') && method === 'GET') {
    return mk(stub.orderRows === null ? [stub.orderRow] : stub.orderRows)
  }
  throw new Error('未预期的出网目标：' + u)
}

const env = (over = {}) => ({
  SUPABASE_URL: 'https://fake',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  PRO_WALLS_ENABLED: 'true',
  PRO_PURCHASE_ENABLED: 'true',
  PRO_ENV: '0',
  PRO_TEST_OPENIDS: '',
  WX_APPID: 'wx1',
  WX_SECRET: 'sec1',
  WX_PAY_OFFER_ID: 'offer-1',
  WX_PAY_APPKEY_PROD: 'appkey-1',
  WX_PUSH_TOKEN: over.pushToken === undefined ? TOKEN : over.pushToken,
  ...over,
})

// 平台侧那把签名：sha1(字典序 sort(Token,timestamp,nonce) 拼接)
const sha1Hex = async (s) => {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
const signFor = async (token, timestamp, nonce) => sha1Hex([String(token), String(timestamp), String(nonce)].sort().join(''))

const req = ({ method = 'GET', query = {}, body = '' }) => ({
  method,
  url: `https://pack.handle.host/push/xpay?${new URLSearchParams(query).toString()}`,
  text: async () => body,
})
const ctx = (r, eover = {}) => ({ request: r, env: env(eover), params: {}, data: {} })

const pushBody = ({ event, outTradeNo = NO, openid = OPENID, extra = '' }) =>
  `<xml><ToUserName><![CDATA[gh_x]]></ToUserName><FromUserName><![CDATA[${openid}]]></FromUserName>` +
  `<CreateTime>1791182274</CreateTime><MsgType><![CDATA[event]]></MsgType>` +
  `<Event><![CDATA[${event}]]></Event><OpenId><![CDATA[${openid}]]></OpenId>` +
  `<OutTradeNo><![CDATA[${outTradeNo}]]></OutTradeNo><Env>0</Env>` +
  `<WeChatPayInfo><MchOrderNo><![CDATA[${outTradeNo}]]></MchOrderNo></WeChatPayInfo>` +
  `<GoodsInfo><ProductId><![CDATA[monthly_mem_android]]></ProductId><Quantity>1</Quantity></GoodsInfo>` +
  `${extra}</xml>`

const errCodeOf = async (res) => {
  const t = await res.text()
  const m = /<ErrCode>(\d+)<\/ErrCode>/.exec(t)
  return m ? Number(m[1]) : '‹没有 ErrCode〉'
}
const writes = () => calls.filter((c) => c.url.includes('/rest/v1/') && !c.url.includes('/rpc/') && (c.method === 'POST' || c.method === 'PATCH'))
const ledgerPatches = () => calls.filter((c) => c.url.includes('/rest/v1/pro_ledger') && c.method === 'PATCH')
const orderPatches = () => calls.filter((c) => c.url.includes('/rest/v1/pro_orders') && c.method === 'PATCH')
const refundedPatches = () => orderPatches().filter((c) => c.body && c.body.status === 'refunded')
const queryCalls = () => calls.filter((c) => c.url.includes('/xpay/query_order'))
const notifyCalls = () => calls.filter((c) => c.url.includes('/xpay/notify_provide_goods'))
const ledgerPosts = () => calls.filter((c) => c.url.includes('/rest/v1/pro_ledger') && c.method === 'POST')
// 取"第 N 次调用"要给一个**看得见的缺调用哨兵**（崩掉的 suite 比红着的格子更坏）
const MISSING = '‹没有那次调用›'
const bodyAt = (list, i = 0) => (list[i] ? list[i].body : MISSING)
// 🔴 取"那一次调用"的 URL 也要哨兵：反证 F4（撤账那一步被拿掉）时这里直接抛 TypeError ⇒
//   整张表崩、一个红格都看不见，而"哪一格守着这条规矩"又变回猜测。
const urlAt = (list, i = 0) => (list[i] ? list[i].url : MISSING)

// 把日志接住：这条通道的"未知事件"那一档**只有日志**是取证机会，判据要能看到它写了什么
let logs = []
const realLog = console.log
const realErr = console.error
console.log = (...a) => { logs.push(['log', a.join(' ')]) }
console.error = (...a) => { logs.push(['err', a.join(' ')]) }
const loggedWith = (needle) => logs.filter(([, s]) => s.includes(needle)).length
const restoreConsole = () => { console.log = realLog; console.error = realErr }

// ── 1. GET 握手 ────────────────────────────────────────────────────────────
{
  reset()
  const ts = '1791182274'
  const nonce = 'abc'
  const sig = await signFor(TOKEN, ts, nonce)
  let res = await onRequestGet(ctx(req({ query: { signature: sig, timestamp: ts, nonce, echostr: 'ECHO-42-xyz' } })))
  check('1.1 签名对 ⇒ 200', res.status, 200)
  check('1.2 🔴 echostr **逐字原样**返回（加引号／trim／包 XML 都会让后台那一次「提交」判失败，而症状像"签名错了"）', await res.text(), 'ECHO-42-xyz')
  check('1.3 握手一次出网都没有（它只是验签，不该惊动平台或库）', calls.length, 0)

  res = await onRequestGet(ctx(req({ query: { signature: 'deadbeef', timestamp: ts, nonce, echostr: 'ECHO-42-xyz' } })))
  check('1.4 签名错 ⇒ 401 且不回 echostr', [res.status, await res.text()], [401, 'invalid signature'])

  res = await onRequestGet(ctx(req({ query: { timestamp: ts, nonce, echostr: 'E' } })))
  check('1.5 缺 signature ⇒ 401（不是"当它没带所以放过"）', res.status, 401)

  res = await onRequestGet(ctx(req({ query: { signature: sig, timestamp: ts, nonce, echostr: 'E' } }), { pushToken: '' }))
  check('1.6 🔴 Token 没配 ⇒ 503（配置缺失不许长得像"签名错了"），且没把 echostr 漏出去', [res.status, await res.text()], [503, 'push receiver not configured'])
}

// ── 2. POST 的三道前置闸：验签不过 ⇒ 一次出网都不许有（E-25）──────────────────
{
  reset()
  const body = pushBody({ event: 'xpay_goods_deliver_notify' })
  let res = await onRequestPost(ctx(req({ method: 'POST', query: { signature: 'bad', timestamp: '1', nonce: '2' }, body })))
  check('2.1 验签不过 ⇒ ErrCode 非 0', await errCodeOf(res), 1)
  check('2.2 🔴 验签不过 ⇒ 零出网：不查平台、不写库、连 access_token 都不取（未验签的输入不许触发任何写）', calls.length, 0)

  reset()
  res = await onRequestPost(ctx(req({ method: 'POST', query: { timestamp: '1', nonce: '2' }, body }), { pushToken: '' }))
  check('2.3 Token 没配 ⇒ 503 ＋ ErrCode 非 0 ＋ 零出网', [res.status, await errCodeOf(res), calls.length], [503, 1, 0])

  reset()
  const ts = '1700000000'
  const sig = await signFor(TOKEN, ts, 'n')
  res = await onRequestPost(ctx(req({ method: 'POST', query: { signature: sig, timestamp: ts, nonce: 'n' }, body: '<xml>'.padEnd(30000, 'x') })))
  check('2.4 超大报文 ⇒ 不解析、零出网（报文本该是几百字的东西）', [await errCodeOf(res), calls.length], [1, 0])
}

// ── 3. 发货通知：入账与三态应答（4.5 那张表）──────────────────────────────────
const deliver = async (eover = {}) => {
  const ts = '1700000001'
  const sig = await signFor(TOKEN, ts, 'n1')
  const res = await onRequestPost(ctx(req({ method: 'POST', query: { signature: sig, timestamp: ts, nonce: 'n1' }, body: pushBody({ event: 'xpay_goods_deliver_notify' }) }), eover))
  return { code: await errCodeOf(res) }
}

reset()
let d = await deliver()
check('3.1 查单已付 ⇒ ErrCode 0', d.code, 0)
check('3.2 一次查单＋一次发货告知＋两次写（订单回填＋账本）', [queryCalls().length, notifyCalls().length, writes().length], [1, 1, 2])

reset()
stub.queryBody = { errcode: 0, order: { status: 1 } }
d = await deliver()
check('3.3 🔴 查得未付 ⇒ ErrCode **非 0**（回 0＝替平台放弃剩下 15 次重推，把几秒的账期延迟做成永久漏发）', [d.code, writes().length], [1, 0])

reset()
stub.queryBody = { errcode: 268490002, errmsg: '数据不存在' }
d = await deliver()
check('3.4 查无此单 ⇒ 同样非 0、零写', [d.code, writes().length], [1, 0])

reset()
stub.queryBody = { errcode: 268490003, errmsg: '签名错误' }
d = await deliver()
check('3.5 查单判不出 ⇒ 非 0、零写（绝不折算成"未付"）', [d.code, writes().length], [1, 0])

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.ledgerRows = [{ id: 'l-1' }]
d = await deliver()
check('3.6 重放（已付＋账本在）⇒ ErrCode 0、零写、不打发货（幂等成功）', [d.code, writes().length, notifyCalls().length, queryCalls().length], [0, 0, 0, 0])

reset()
stub.orderRow = orderRow({ status: 'anomaly', anomaly_reason: 'refunded_not_credited' })
d = await deliver()
check('3.7 anomaly ⇒ 拒绝复活（零写）；应答仍是非 0＝人工没看过之前不停推（重推有上限，而"停推"不可逆）', [d.code, writes().length, queryCalls().length], [1, 0, 0])

reset()
stub.orderRows = []
d = await deliver()
check('3.8 库里没这单 ⇒ 非 0 且一次平台调用都不打（单号可能是别人拼的）', [d.code, queryCalls().length, writes().length], [1, 0, 0])

// ── 4. 退款通知：只认查单，撤账在前、改状态在后 ───────────────────────────────
const refund = async () => {
  const ts = '1700000002'
  const sig = await signFor(TOKEN, ts, 'n2')
  const res = await onRequestPost(ctx(req({ method: 'POST', query: { signature: sig, timestamp: ts, nonce: 'n2' }, body: pushBody({ event: 'xpay_refund_notify' }) })))
  return await errCodeOf(res)
}

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.queryBody = { errcode: 0, order: { status: 5, left_fee: 0, paid_time: PAID_SEC } }
let code = await refund()
{
  const revIdx = calls.findIndex((c) => c.url.includes('/rest/v1/pro_ledger') && c.method === 'PATCH')
  const markIdx = calls.findIndex((c) => c.url.includes('/rest/v1/pro_orders') && c.method === 'PATCH')
  check('4.1 查单说已退 ⇒ ErrCode 0、撤账一次、改状态一次', [code, ledgerPatches().length, refundedPatches().length], [0, 1, 1])
  check('4.2 🔴 写序＝先撤账本、后改订单状态（反过来留下的形状是"订单说已退款、权益却还在"＝今天那个现场）', [revIdx >= 0, markIdx > revIdx], [true, true])
  check('4.3 撤账那一条过滤带 revoked_at=is.null（重放不把撤销时刻挪后）', urlAt(ledgerPatches()).includes('revoked_at=is.null'), true)
  const b = bodyAt(refundedPatches())
  check('4.4 留痕两列都写（D-9a：谁做的、怎么核实的）', b === MISSING ? [MISSING, false] : [b.operator, String(b.note).startsWith('xpay_refund_notify')], ['xpay_refund_notify', true])
  check('4.5 🔴 改状态那一条只吃 status=eq.paid（库侧 CHECK 不许 paid_at 为空的行变 refunded）', urlAt(refundedPatches()).includes('status=eq.paid'), true)
}

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.queryBody = { errcode: 0, order: { status: 5 } }
stub.ledgerRevokeRows = []
code = await refund()
check('4.6 撤账匹配 0 行（之前已撤过）⇒ 仍继续补状态、应答 0（半截状态能自愈）', [code, refundedPatches().length], [0, 1])

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.queryBody = { errcode: 0, order: { status: 5 } }
stub.refundedPatchRows = []
code = await refund()
check('4.7 🔴 改状态 200 但零行 ⇒ 按"没改成"处理：应答非 0 让平台重推（权益已撤＝方向对，状态等下一次补）', [code, ledgerPatches().length], [1, 1])

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.queryBody = { errcode: 0, order: { status: 3, paid_time: PAID_SEC } }
code = await refund()
check('4.8 推送说退、查单说付 ⇒ 以查单为准**入账**（ErrCode 0、账本写一行、并打发货）', [code, ledgerPosts().length, notifyCalls().length], [0, 1, 1])

reset()
stub.orderRow = orderRow({ status: 'pending' })
stub.queryBody = { errcode: 0, order: { status: 5 } }
code = await refund()
check('4.9 从没入账的单被退 ⇒ refunded_not_credited：零写、但应答 0（这是已判定的事实，不是"还没查到"；A3 接手）', [code, writes().length], [0, 0])

reset()
stub.orderRow = orderRow({ status: 'anomaly', anomaly_reason: 'refunded_not_credited' })
stub.queryBody = { errcode: 0, order: { status: 5 } }
code = await refund()
check('4.10 anomaly 行收到退款推送 ⇒ 同样只停推、不动它（出边只有人工，4.5 第 7 步）', [code, writes().length], [0, 0])

reset()
stub.orderRow = orderRow({ status: 'refunded', paid_at: PAID_ISO })
code = await refund()
check('4.11 已是 refunded ⇒ 幂等成功、连平台都不查（省一次出网，也免得再撤一次）', [code, queryCalls().length, writes().length], [0, 0, 0])

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.queryBody = { errcode: 0, order: { status: 1 } }
code = await refund()
check('4.12 🔴 查单说未付 ⇒ 绝不撤账（撤权益的方向比漏发更坏：它伤的是付了钱没退款的人）', [code, writes().length], [1, 0])

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.queryBody = { errcode: 999999, errmsg: 'boom' }
code = await refund()
check('4.13 查单判不出 ⇒ 不撤、应答非 0（等重推）', [code, writes().length], [1, 0])

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.queryBody = { errcode: 0, order: { status: 5 } }
code = await refund()
const firstRevoke = ledgerPatches().length
// 第一次之后库里那一行确实变成 refunded 了 ⇒ 桩跟着改（否则第二次测的是桩、不是代码）
stub.orderRow = orderRow({ status: 'refunded', paid_at: PAID_ISO })
code = await refund()
check('4.14 同一笔连推两次 ⇒ 第二次走 already_refunded、撤账只发生一次、连平台都不再查', [code, firstRevoke, ledgerPatches().length, queryCalls().length], [0, 1, 1, 1])

// ── 5. 报文解析与"未知事件" ──────────────────────────────────────────────────
reset()
logs = []
{
  const ts = '1700000003'
  const sig = await signFor(TOKEN, ts, 'n3')
  const res = await onRequestPost(ctx(req({ method: 'POST', query: { signature: sig, timestamp: ts, nonce: 'n3' }, body: pushBody({ event: 'xpay_something_new' }) })))
  check('5.1 认不出的事件名 ⇒ 非 0（不停推）且零写', [await errCodeOf(res), writes().length], [1, 0])
  check('5.2 🔴 且把原文打进日志——事件名只有工程稿给过，第一次真推是唯一发现机会', loggedWith('[pro-push] unknown event') >= 1, true)
}
reset()
{
  const ts = '1700000004'
  const sig = await signFor(TOKEN, ts, 'n4')
  const res = await onRequestPost(ctx(req({ method: 'POST', query: { signature: sig, timestamp: ts, nonce: 'n4' }, body: '<xml><Event><![CDATA[xpay_goods_deliver_notify]]></Event><Env>0</Env></xml>' })))
  check('5.3 验签过了但没有 OutTradeNo ⇒ 非 0、零出网（宁可让平台重推，也不拿读不出的报文去改状态）', [await errCodeOf(res), calls.length], [1, 0])
}
{
  const f = readPushFields('<xml><Event>E</Event><OutTradeNo>T9</OutTradeNo><Evil><![CDATA[boom]]></Evil><Inner><Deep>x</Deep></Inner></xml>')
  check('5.4 🔴 白名单之外的字段读不出来（不写通用 XML 解析器＝少一个能吃畸形输入的面）', ['Evil' in f, 'Deep' in f, 'Inner' in f], [false, false, false])
  check('5.5 嵌套的 WeChatPayInfo.MchOrderNo／GoodsInfo.ProductId 读得到（B4 与巡检要用，今天不参与判定）', (() => {
    const g = readPushFields(pushBody({ event: 'xpay_refund_notify' }))
    return [g.mchOrderNo, g.productId, g.quantity]
  })(), [NO, 'monthly_mem_android', '1'])
}

// ── 5b. 🔴 真推来的那一纸（2026-10-05 17:20 现网 tail 原文，正本附录甲）──────────
// 第一次真推就把字段名给我们纠正了：退款通知里的单号叫 `MchOrderId`，**不是**个人版页转述的
// `OutTradeNo`；而"商户退款单号/微信退款单号/退款金额"是 `MchRefundId`／`WxRefundId`／`RefundFee`。
// 旧解析读不到单号 ⇒ 三条推送全落在"读不出"那一档、应答失败、零写（E-25 那套 fail-closed 的形状），
// 而这一格钉的就是"这一纸现在要能被读懂"。
const REAL_REFUND_XML =
  '<xml><ToUserName><![CDATA[gh_3ce2cbec98b6]]></ToUserName> <FromUserName><![CDATA[' + OPENID + ']]></FromUserName> ' +
  '<CreateTime>1791192028</CreateTime> <MsgType><![CDATA[event]]></MsgType> ' +
  '<Event><![CDATA[xpay_refund_notify]]></Event> <OpenId><![CDATA[' + OPENID + ']]></OpenId> ' +
  '<WxRefundId><![CDATA[VPR26100517083913588]]></WxRefundId> <MchRefundId><![CDATA[VPR26100517083909476]]></MchRefundId> ' +
  '<WxOrderId><![CDATA[VPO261005154518026737539]]></WxOrderId> <MchOrderId><![CDATA[' + NO + ']]></MchOrderId> ' +
  '<RefundFee>333</RefundFee> <RetCode>0</RetCode> <RetMsg><![CDATA[success]]></RetMsg></xml>'
{
  const f = readPushFields(REAL_REFUND_XML)
  check("5b.1 🔴 真推的单号从 `MchOrderId` 读得出来（旧写法只认 OutTradeNo ⇒ 三条真推全部'读不出'）", f.outTradeNo, NO)
  check('5b.2 退款那一支的三个字段都读得到（留痕与 B4 要用）', [f.refundId, f.mchRefundId, f.refundFee, f.wxOrderId], ['VPR26100517083913588', 'VPR26100517083909476', '333', 'VPO261005154518026737539'])
  check('5b.3 openid 从 OpenId 读到（与 FromUserName 同值，两个都认）', f.openid, OPENID)
  check('5b.4 两种拼写同时在场时以 OutTradeNo 优先（那是发货推送那一列的转述，不冲突时不猜）', readPushFields('<xml><OutTradeNo>A</OutTradeNo><MchOrderId>B</MchOrderId></xml>').outTradeNo, 'A')
}
reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.queryBody = { errcode: 0, order: { status: 5 } }
{
  const ts = '1700000005'
  const sig = await signFor(TOKEN, ts, 'n5')
  const res = await onRequestPost(ctx(req({ method: 'POST', query: { signature: sig, timestamp: ts, nonce: 'n5' }, body: REAL_REFUND_XML })))
  check('5b.5 🔴 这一纸现在真的会撤账（旧代码走到"读不出单号"就停了）', [await errCodeOf(res), ledgerPatches().length, refundedPatches().length], [0, 1, 1])
  check('5b.6 平台侧退款单号进 note（D-9a：怎么核实的要能被追责）', String(bodyAt(refundedPatches()).note).includes('VPR26100517083913588'), true)
}
reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO, payer_openid: 'oSomeoneElse' })
{
  const ts = '1700000006'
  const sig = await signFor(TOKEN, ts, 'n6')
  const res = await onRequestPost(ctx(req({ method: 'POST', query: { signature: sig, timestamp: ts, nonce: 'n6' }, body: REAL_REFUND_XML })))
  check('5b.7 🔴 推送里的 openid 与订单行的 payer_openid 对不上 ⇒ 不撤、零写、应答非 0（验签只证明"来自平台"，不证明"与该账号有关"）', [await errCodeOf(res), writes().length, queryCalls().length], [1, 0, 0])
}

// ── 6. 静态闸：这条通道的形状不许被第二份实现稀释 ─────────────────────────────
const JS = []
;(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.js')) JS.push(p)
  }
})(path.join(root, 'functions'))
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
// 🔴 判"这条通道不许碰 X"时要**先剥行注释**：文件头那些注释本来就在解释"为什么不看购买开关"，
//   不剥就会把反例自己染红（同 `check:pro` 那轮 JSX 注释的教训）。
const ROUTE = read(path.join(root, 'functions/push/xpay.js'))
const ROUTE_CODE = ROUTE.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
check('6.1 🔴 验签算法只有一处（两处就会长成两份不完全一样的判断，坏的那份静默放过）', JS.filter((p) => /sort\(\)\.join\(''\)/.test(read(p))).map((p) => path.relative(root, p)), ['functions\\_lib\\proPush.js'])
check('6.2 三张会员表的 URL 不出现在接收器里（写面仍只有 proStore）', /rest\/v1\/pro_(orders|ledger|refund_requests)/.test(ROUTE_CODE), false)
check('6.3 接收器不 import 签名模块⇒这条链上不碰 session_key／一次性 code', /proPaySign/.test(ROUTE_CODE), false)
check('6.4 🔴 接收器不看购买开关（钱进了就得认、撤账更不能按开关关）', /PRO_PURCHASE_ENABLED|readProFlags/.test(ROUTE_CODE), false)
check('6.5 路由在 /api/** 之外（那层中间件对所有 /api/** 要 Bearer 且无豁免 ⇒ 放错目录＝永远收不到）', readFileSync(path.join(root, 'functions/push/xpay.js'), 'utf8').length > 0 && !path.join(root, 'functions/push/xpay.js').includes(path.join('functions', 'api')), true)
check('6.6 refundOrder 与 creditOrder 同处一个模块（状态机的两条出边不许分家）', JS.filter((p) => /export async function refundOrder/.test(read(p))).map((p) => path.relative(root, p)), ['functions\\_lib\\proCredit.js'])

restoreConsole()

const failed = results.filter((x) => !x.ok)
for (const x of failed) console.log(`✗ ${x.name}\n    got  ${JSON.stringify(x.got)}\n    want ${JSON.stringify(x.want)}`)
console.log(`${results.length - failed.length}/${results.length} 格通过`)
if (failed.length) process.exitCode = 1
