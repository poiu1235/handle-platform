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
  // E-36 判甲：撤账成功之后接收器会去关那条自助申请行（读它＋PATCH 它，两样都要有桩）
  requestRows: [],
  finalizeRows: [{ id: 'r-1' }],
  finalizeStatus: 200,
  queryBody: { errcode: 0, errmsg: 'ok', order: { status: 3, paid_time: PAID_SEC, wx_order_id: 'VPO-1', wxpay_order_id: '4500-1' } },
  notifyBody: { errcode: 0, errmsg: 'OK' },
  tokenBody: { access_token: 'TOKEN-x', expires_in: 7200 },
  coverageBody: { is_covered: false, valid_until: null, remaining_days: null },
  pushToken: TOKEN,
  // ── E-40（`no_such_order` 取证行）用的三个旋钮 ──
  identityRows: [], // []＝这个微信当前没绑账号 ⇒ `user_id` 走哨兵；[{user_id}]＝唯一 ⇒ 用真 id
  orderInsertRows: [{ id: 'an-1' }], // representation 回几行＝"到底落没落成"，调用方要数
  orderInsertStatus: 201,
  orderInsertConflict: null, // { code:'23505', message:'…pro_orders_out_trade_no_key…' } ⇒ 单号已有行
  orderRowQueue: null, // 非 null 时按序供给每次订单读（每次给一个数组），见 fetch 桩那条注释
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
    // ⚠️ `orderRowQueue`：每次读给一个**数组**（E-41 那条"撞号⇒立刻重试"要的就是
    //   "第一读没这行、第二读有这行"这个形状）。取空就回 []，不抛。
    if (stub.orderRowQueue !== null) {
      const next = stub.orderRowQueue.shift()
      return mk(next === undefined ? [] : next)
    }
    return mk(stub.orderRows === null ? [stub.orderRow] : stub.orderRows)
  }
  if (u.includes('/rest/v1/pro_refund_requests') && method === 'PATCH') {
    return mk(stub.finalizeStatus === 200 ? stub.finalizeRows : { message: 'finalize boom' }, stub.finalizeStatus)
  }
  if (u.includes('/rest/v1/pro_refund_requests')) return mk(stub.requestRows)
  // ── E-40 新增的两条路由 ────────────────────────────────────────────────
  // 反查 `user_id`（`accountIdsByOpenid`）：默认空数组＝这个微信当前没绑账号 ⇒ 走哨兵值。
  if (u.includes('/rest/v1/user_identities')) return mk(stub.identityRows)
  // 落 anomaly 取证行那一次 POST：桩把"回几行"与"撞号"都做成可控，因为调用方**要数改到几行**。
  if (u.includes('/rest/v1/pro_orders') && method === 'POST') {
    if (stub.orderInsertConflict) return mk(stub.orderInsertConflict, 409)
    return mk(stub.orderInsertRows, stub.orderInsertStatus)
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

const pushBody = ({ event, outTradeNo = NO, openid = OPENID, productId = 'monthly_mem_android', extra = '' }) =>
  `<xml><ToUserName><![CDATA[gh_x]]></ToUserName>` +
  (openid === null ? '' : `<FromUserName><![CDATA[${openid}]]></FromUserName>`) +
  `<CreateTime>1791182274</CreateTime><MsgType><![CDATA[event]]></MsgType>` +
  `<Event><![CDATA[${event}]]></Event>` +
  (openid === null ? '' : `<OpenId><![CDATA[${openid}]]></OpenId>`) +
  `<OutTradeNo><![CDATA[${outTradeNo}]]></OutTradeNo><Env>0</Env>` +
  `<WeChatPayInfo><MchOrderNo><![CDATA[${outTradeNo}]]></MchOrderNo></WeChatPayInfo>` +
  `<GoodsInfo><ProductId><![CDATA[${productId}]]></ProductId><Quantity>1</Quantity></GoodsInfo>` +
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

// ── 3.8…3.16 E-40：库里没这单时的那一行取证（4.5 第 2 步那句「不能只写日志」）──────
// 这一节判的重点不是"能不能写"，而是**哪些情况下它必须不写**：这一行会被 A3 巡检看见、
// 会被人在订单页读成"处理中"，写错就是拿一条我们没证的记录去占人的注意力。
const deliverWith = async (body) => {
  const ts = '1700000009'
  const sig = await signFor(TOKEN, ts, 'n9')
  const res = await onRequestPost(ctx(req({ method: 'POST', query: { signature: sig, timestamp: ts, nonce: 'n9' }, body })))
  return { code: await errCodeOf(res) }
}
const anomalyPosts = () => calls.filter((c) => c.url.includes('/rest/v1/pro_orders') && c.method === 'POST')
const NIL_USER_ID = '00000000-0000-0000-0000-000000000000'

reset()
stub.orderRows = []
d = await deliver()
// ⚠️ 这一格原来钉的是「库里没这单 ⇒ 非 0、零写、一次平台调用都不打（单号可能是别人拼的）」。
//   E-40 把它**改掉**了：那条"零写"正是正本 `:356` 判为不可接受的"只写日志"——重推 15 次耗尽之后
//   这笔钱在库里零痕迹，而 `/admin/pro-anomaly` 是按 `out_trade_no` 取行的，没有行就没有人工出边。
//   而"单号可能是别人拼的"那一层本来就由**验签**挡（E-25：过不了签的报文一个库都不写，见第 2 节），
//   能走到这一支的必然是签过的报文 ⇒ 现行期望＝落一行取证行＋应答 0 停推。撤一条门要写清换成了什么。
check('3.8 🔴 库里没这单（验签已过）⇒ 不再"零写"：落一行 anomaly/no_such_order 当地址并停推（E-40 改写此格）',
  [d.code, anomalyPosts().length, bodyAt(anomalyPosts()).status, bodyAt(anomalyPosts()).anomaly_reason], [0, 1, 'anomaly', 'no_such_order'])
check('3.9 这一支**不入账**：零账本写、零发货告知（查单只当凭据用，不作为发权益的依据）',
  [ledgerPosts().length, notifyCalls().length, queryCalls().length], [0, 0, 1])
check('3.10 落的是异常单该有的形状：paid_at 为空、状态不是 pending（pending 会被前置④ 当未付单复用）',
  [bodyAt(anomalyPosts()).paid_at, bodyAt(anomalyPosts()).expires_at !== undefined, bodyAt(anomalyPosts()).out_trade_no],
  [undefined, true, NO])

reset()
stub.orderRows = []
await deliverWith(pushBody({ event: 'xpay_goods_deliver_notify', extra: '<ActualPrice>1</ActualPrice><TotalFee>1</TotalFee>' }))
check('3.11 🔴 金额只有一个来源＝按推送的 product_id 反查价表（333）；报文里塞两句"价"也不改它（6.2 铁律 3）',
  bodyAt(anomalyPosts()).goods_price, 333)

reset()
stub.orderRows = []
d = await deliverWith(pushBody({ event: 'xpay_goods_deliver_notify', openid: null }))
check('3.12 🔴 缺 openid ⇒ 零写＋应答非 0（查单要它、payer_openid not-null 也要它，而"是不是这个微信付的"根本判不出）',
  [d.code, anomalyPosts().length, queryCalls().length], [1, 0, 0])

reset()
stub.orderRows = []
d = await deliverWith(pushBody({ event: 'xpay_goods_deliver_notify', productId: 'ghost_item' }))
check('3.13 🔴 道具不在价表 ⇒ 零写＋应答非 0（🔴 不编金额：CHECK 只挡得住 0，挡不住"随手填个 1 分占位"，而这一行是给人看的）',
  [d.code, anomalyPosts().length], [1, 0])

reset()
// ⚠️ 这一格原来是"撞号 ⇒ 应答非 0"那一支。E-41 丙 之后撞号会**就地重试入账**，那个形状已经由 3.20／3.21
//   分别接走（重试读到行／读不到行的两种都有）；而"撞号但仍读不到行"是个自相矛盾的桩状态
//   （撞 unique 就说明那行在），拿它当场景只会测一个现实中不存在的分支。⇒ 这一格改成管**另一种失败**：
//   插取证行时库侧报错（非撞号）⇒ 没落成落点 ⇒ 应答非 0、且**不去重试入账**（没行就没地址）。
stub.orderRows = []
stub.orderInsertStatus = 500
d = await deliver()
check('3.14 🔴 插取证行被库侧拒绝（非撞号）⇒ 应答非 0、不重试入账：没落成地址就绝不停推',
  [d.code, anomalyPosts().length, ledgerPosts().length, queryCalls().length], [1, 1, 0, 1])

reset()
// 第一读没这行（⇒ 去插取证行、撞号），第二读有这行（⇒ 立刻按那一行走正常入账）
stub.orderRowQueue = [[], [orderRow()]]
stub.orderInsertConflict = { code: '23505', message: 'duplicate key value violates unique constraint "pro_orders_out_trade_no_key"' }
d = await deliver()
check('3.20 🔴 撞号之后重试读到了那一行、平台答已付 ⇒ 当场入账、应答 0（幂等闸门在 pro_ledger.order_id unique，重试做不出双份）',
  [d.code, anomalyPosts().length, ledgerPosts().length, notifyCalls().length, queryCalls().length], [0, 1, 1, 1, 2])

reset()
stub.orderRowQueue = [[], [orderRow()]]
stub.orderInsertConflict = { code: '23505', message: 'duplicate key value violates unique constraint "pro_orders_out_trade_no_key"' }
stub.queryBody = { errcode: 0, order: { status: 1 } } // 平台说这张单还开着、还没付
d = await deliver()
check('3.21 重试也答不出"已付" ⇒ 零账本、应答非 0（没落成落点之前绝不停推，与 3.12/3.13 同一侧）',
  [d.code, ledgerPosts().length, notifyCalls().length, anomalyPosts().length], [1, 0, 0, 1])

reset()
stub.orderRows = []
stub.orderInsertRows = [] // 插成功但 representation 回 0 行
d = await deliver()
check('3.15 🔴 插了但回 0 行＝不算落成：应答非 0（"我以为写了"与"确实写了"必须能分开——E-19 那一族）',
  [d.code, anomalyPosts().length], [1, 1])

reset()
stub.orderRows = []
stub.identityRows = [{ user_id: UID }]
await deliver()
check('3.16 这个微信唯一绑着一个账号 ⇒ user_id 用真 id，note 写明来源是 identity',
  [bodyAt(anomalyPosts()).user_id, String(bodyAt(anomalyPosts()).note).includes('user_id=identity')], [UID, true])

reset()
stub.orderRows = []
stub.identityRows = [{ user_id: 'u-a' }, { user_id: 'u-b' }]
await deliver()
check('3.17 🔴 反查出来两个账号 ⇒ 用哨兵值且 note 写明 ambiguous（不替它挑一行；user_id 按 4.2 只作留痕）',
  [bodyAt(anomalyPosts()).user_id, String(bodyAt(anomalyPosts()).note).includes('sentinel:ambiguous_2')], [NIL_USER_ID, true])

reset()
stub.orderRows = []
stub.queryBody = { errcode: 0, errmsg: 'ok', order: { status: 1 } } // 平台说这张单还没付
await deliver()
check('3.18 查得未付 ⇒ **照样落行**（"平台推来一单而我们没有"这件事来自推送本身，不来自查单），note 里写的是未付',
  [anomalyPosts().length, String(bodyAt(anomalyPosts()).note).includes('查单＝unpaid'), ledgerPosts().length], [1, true, 0])

reset()
stub.orderRows = []
logs = []
await deliver()
check('3.19 🔴 这一支每一次都打 error 级日志（钱可能进了平台而我们连单都没有，不是常规流量；tail 里要跳出来）',
  loggedWith('deliver without a local order') >= 1, true)

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

// ── 4.10…4.14 E-36 判甲：撤账成功之后，接收器顺手关掉那条**用户自己点出来的**申请行 ──
//   （E-30 判甲禁的是"凭空创建 external 行"，这一支关的是已存在的行，两件事不冲突）
const finalizePatches = () => calls.filter((c) => c.url.includes('/rest/v1/pro_refund_requests') && c.method === 'PATCH')
const refundWith = async (extra) => {
  const ts = '1700000004'
  const sig = await signFor(TOKEN, ts, 'n4')
  const res = await onRequestPost(ctx(req({ method: 'POST', query: { signature: sig, timestamp: ts, nonce: 'n4' }, body: pushBody({ event: 'xpay_refund_notify', extra }) })))
  return await errCodeOf(res)
}
const RECEIPT = '<WxRefundId><![CDATA[VPR26100521083872708]]></WxRefundId><RefundFee>1</RefundFee>'

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.queryBody = { errcode: 0, order: { status: 5, left_fee: 0 } }
stub.requestRows = [{ id: 'r-1', order_id: OID, kind: 'no_reason', status: 'pending', requested_at: PAID_ISO, executed_at: null, note: null }]
code = await refundWith(RECEIPT)
{
  const b = finalizePatches().length ? finalizePatches()[0].body : null
  check('4.10 🔴 有 pending 行＋推送带回执号 ⇒ 关成 done，operator 是触发源、回执号落库（E-29 那条 CHECK 要的就是它）',
    [code, finalizePatches().length, b ? [b.status, b.operator, b.wx_refund_id] : null],
    [0, 1, ['done', 'xpay_refund_notify', 'VPR26100521083872708']])
  check('4.11 关行的 PATCH 过滤 status=eq.pending（被人抢先就匹配 0 行，不覆盖别人的终态）',
    finalizePatches().length ? finalizePatches()[0].url.includes('status=eq.pending') : null, true)
}

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.queryBody = { errcode: 0, order: { status: 5, left_fee: 0 } }
code = await refundWith(RECEIPT)
check('4.12 没有申请行（后台直退那一类）⇒ 撤账照做、**零** finalize PATCH、应答 0（那种单归 A6 人工登记）',
  [code, ledgerPatches().length, finalizePatches().length], [0, 1, 0])

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.queryBody = { errcode: 0, order: { status: 5, left_fee: 0 } }
stub.requestRows = [{ id: 'r-1', order_id: OID, kind: 'no_reason', status: 'pending', requested_at: PAID_ISO, executed_at: null, note: null }]
code = await refundWith('') // 没有 WxRefundId
check('4.13 🔴 推送没带回执号 ⇒ **不许**写 done（E-29 的 CHECK 会把它挡成 23514，而挡下来是对的）：零 finalize PATCH、应答仍 0',
  [code, ledgerPatches().length, finalizePatches().length], [0, 1, 0])

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.queryBody = { errcode: 0, order: { status: 5, left_fee: 0 } }
stub.requestRows = [{ id: 'r-1', order_id: OID, kind: 'no_reason', status: 'pending', requested_at: PAID_ISO, executed_at: null, note: null }]
stub.finalizeRows = []
code = await refundWith(RECEIPT)
check('4.14 关行匹配 0 行（管理员刚处理过）⇒ 应答仍 0：钱与权益已对齐，为一行簿记让平台重推整次撤账不值得', [code, finalizePatches().length], [0, 1])

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.queryBody = { errcode: 0, order: { status: 5, left_fee: 0 } }
stub.requestRows = [{ id: 'r-1', order_id: OID, kind: 'no_reason', status: 'pending', requested_at: PAID_ISO, executed_at: null, note: null }]
stub.finalizeStatus = 500
code = await refundWith(RECEIPT)
check('4.15 关行那一次抛错 ⇒ 应答仍 0（同上），且撤账与改状态都没被它带坏', [code, ledgerPatches().length, refundedPatches().length], [0, 1, 1])

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.queryBody = { errcode: 0, order: { status: 5, left_fee: 0 } }
stub.requestRows = [
  { id: 'r-1', order_id: OID, kind: 'no_reason', status: 'done', requested_at: PAID_ISO, executed_at: PAID_ISO, note: null },
  { id: 'r-2', order_id: OID, kind: 'no_reason', status: 'pending', requested_at: PAID_ISO, executed_at: null, note: null },
]
code = await refundWith(RECEIPT)
check('4.16 同一订单上已有 done 又有 pending（被拒后重申请过）⇒ 只关 pending 那一条',
  [finalizePatches().length, finalizePatches().length ? finalizePatches()[0].url.includes('id=eq.r-2') : null], [1, true])

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
