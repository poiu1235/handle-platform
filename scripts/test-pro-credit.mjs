// B3-3 入账事务与确认态轮询的离线判据：跑**真源码** `_lib/proCredit.js` 与
// `functions/api/pro/orders/[no].js`（fetch 打桩成假 Supabase、假 token、假 query_order）。
// 用法：npm run test:credit
//
// 这一份为什么必须存在（与 test:orders 的分工）：下单那侧判的是"要不要再收一笔钱"，
// 本文件判的是**钱已经付了之后那三件事**——时刻换算、幂等、以及"没查到"绝不当成"没付"。
// 这三件事的共同点是：出错都不抛异常，症状是"用户付了钱看不到会员"或"一个人白拿两份权益"。
// 只有打桩能看到"几次 POST 到 pro_ledger、body 里有没有 order_id、paid_at 是哪一年"。
//
// ⚠️ 它证明不了的：`in.(pending,closed)` 在真 PostgREST 上到底匹配几行（那是 B0 核对脚本与真机的活）、
//   推送那一路的验签（还欠文档，见 R-9），以及 🔴 **`notify_provide_goods` 的请求形状**——
//   第 6b 节判的是"该打的时候打一次、不该打的时候一次都不打"，接口收到 `order_id` 之后怎么处理
//   只有真单能证（形状来自通用文档树的工具抓取，尚未逐字复核＝R-9 ⑥；取证格＝验收 #71）。
//   ✅ 已经由真机结案的：`paid_time`＝unix 秒、已付的单回 `status:3`（2026-10-05 两轮，附录甲）。

import path from 'node:path'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const results = []
const check = (name, got, want) => results.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want })

const { creditOrder, queryOrderState } = await import(pathToFileURL(path.join(root, 'functions/_lib/proCredit.js')).href)
const { xpayNotifyProvideGoods } = await import(pathToFileURL(path.join(root, 'functions/_lib/proXpay.js')).href)
const { insertLedgerRow } = await import(pathToFileURL(path.join(root, 'functions/_lib/proStore.js')).href)
const { onRequestGet } = await import(pathToFileURL(path.join(root, 'functions/api/pro/orders/[no].js')).href)

const OID = '11111111-1111-4111-8111-111111111111'
const NO = 'T1727000000000deadbeef'
const OPENID = 'oBound'
const UID = 'u-1'
const PAID_SEC = 1790000000 // unix 秒（附录甲：query_order 的 paid_time 是秒）
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
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 600_000).toISOString(),
  is_duplicate: false,
  paid_after_close: false,
  ...over,
})
const defaultStub = () => ({
  orderRow: orderRow(),
  orderRows: null, // 非 null 时覆盖（空数组＝库里没这单）
  orderRowQueue: null, // 非 null 时按序供给每次 GET（同一次请求里读两次的场景，见 fetch 桩那条注释）
  orderReadStatus: 200,
  ledgerRows: [],
  ledgerReadStatus: 200,
  ledgerInsertStatus: 201,
  ledgerInsertError: null,
  patchStatus: 200,
  tokenBody: { access_token: 'TOKEN-x', expires_in: 7200 },
  tokenStatus: 200,
  queryBody: { errcode: 0, errmsg: 'ok', order: { status: 4, paid_time: PAID_SEC, wx_order_id: 'VPO-1', wxpay_order_id: '4500-1', channel_order_id: '2026-1' } },
  queryThrows: false,
  notifyBody: { errcode: 0, errmsg: 'ok' },
  notifyStatus: 200,
  notifyThrows: false,
  coverageBody: { is_covered: false, valid_until: null, remaining_days: null },
  coverageStatus: 200,
  identityRows: [{ openid: OPENID }],
  identityStatus: 200,
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
  if (u.includes('api.weixin.qq.com/cgi-bin/token')) {
    if (stub.tokenStatus !== 200) return mk({ errcode: 40013, errmsg: 'invalid appid' }, stub.tokenStatus)
    return mk(stub.tokenBody)
  }
  if (u.includes('/xpay/query_order')) {
    if (stub.queryThrows) throw new Error('socket hang up')
    return mk(stub.queryBody)
  }
  if (u.includes('/xpay/notify_provide_goods')) {
    if (stub.notifyThrows) throw new Error('socket hang up')
    if (stub.notifyBody === null) return { ok: stub.notifyStatus === 200, status: stub.notifyStatus, json: async () => { throw new Error('not json') } }
    return mk(stub.notifyBody, stub.notifyStatus)
  }
  if (u.includes('/rest/v1/rpc/pro_coverage')) return mk(stub.coverageBody, stub.coverageStatus)
  if (u.includes('/rest/v1/user_identities')) return mk(stub.identityRows, stub.identityStatus)
  if (u.includes('/rest/v1/pro_ledger') && method === 'POST') {
    if (stub.ledgerInsertStatus !== 201) return mk(stub.ledgerInsertError || { message: 'ledger boom' }, stub.ledgerInsertStatus)
    return mk({}, 201)
  }
  if (u.includes('/rest/v1/pro_ledger')) {
    if (stub.ledgerReadStatus !== 200) return mk({ message: 'ledger read boom' }, stub.ledgerReadStatus)
    return mk(stub.ledgerRows)
  }
  if (u.includes('/rest/v1/pro_orders') && method === 'PATCH') {
    if (stub.patchStatus !== 200) return mk({ message: 'patch boom' }, stub.patchStatus)
    // 🔴 `Prefer: return=representation` ⇒ 改到的行会回成数组。桩必须回数组，
    //   否则 `markOrderPaid` 会按"没匹配到行"抛错（那正是它新加的那道判据在做的事）。
    return mk(stub.patchRows === undefined ? [{ out_trade_no: NO, status: 'paid' }] : stub.patchRows, 200)
  }
  if (u.includes('/rest/v1/pro_orders') && method === 'GET') {
    if (stub.orderReadStatus !== 200) return mk({ message: 'order read boom' }, stub.orderReadStatus)
    // ⚠️ `orderRowQueue`（E-41 甲′ 那一族要用）：**同一次请求里读两次**的场景（第一次读到 pending、
    //   去写 closed 时匹配 0 行 ⇒ 重读一次看它现在到底是什么状态）。桩原来是单值的，
    //   那种"两次读给出不同行"的形状就测不了——而它正是这条链上最坏那句话的发生地。
    //   队列取空就回 []（端点会 404，看得见；不抛，免得崩掉整张表）。
    if (stub.orderRowQueue !== null) {
      const next = stub.orderRowQueue.shift()
      return mk(next === undefined ? [] : [next])
    }
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
  ...over,
})

const ledgerPosts = () => calls.filter((c) => c.url.includes('/rest/v1/pro_ledger') && c.method === 'POST')
const orderPatches = () => calls.filter((c) => c.url.includes('/rest/v1/pro_orders') && c.method === 'PATCH')
const queryCalls = () => calls.filter((c) => c.url.includes('/xpay/query_order'))
const notifyCalls = () => calls.filter((c) => c.url.includes('/xpay/notify_provide_goods'))
// 🔴 "零写"只数**对库的** POST/PATCH。第一次跑这张表时这条漏了：`/xpay/query_order` 也是 POST，
//   于是"查单判不出⇒零写"那几格永远红——而红的原因跟业务无关。判据写宽了比写窄更坏：
//   它会把人训练成"这格红了是正常的"，等真漏写时就没人看了。同理 `/rpc/pro_coverage` 是**只读**
//   函数却用 POST 发，也要排除。
const writes = () =>
  calls.filter((c) => c.url.includes('/rest/v1/') && !c.url.includes('/rpc/') && (c.method === 'POST' || c.method === 'PATCH'))
const credit = (no = NO, eover = {}) => creditOrder(env(eover), no)
const conflictBody = { code: '23505', message: 'duplicate key value violates unique constraint "pro_ledger_order_id_key"' }

// 🔴 取"第 N 次调用"时必须给一个**看得见的缺调用哨兵**：反证跑 M2（账本漏 order_id）时，
//   写入口直接把那次 POST 拦掉了，于是 `[0].body` 抛 TypeError ⇒ 整张表崩、红格一个都看不到。
//   崩掉的 suite 比红着的格子更坏：它把"哪一格守住了这条规矩"这个问题重新变成猜测。
const MISSING = '‹没有那次调用›'
const bodyAt = (list, i = 0) => (list[i] ? list[i].body : MISSING)
const urlAt = (list, i = 0) => (list[i] ? list[i].url : MISSING)

// ── 1. 主干：查得已付 ⇒ 回填订单 + 写账本 ───────────────────────────────────
reset()
let res = await credit()
check('1.1 已付 ⇒ credited', res.outcome, 'credited')
check('1.2 恰好两次写：一次 PATCH 订单、一次 POST 账本', [orderPatches().length, ledgerPosts().length], [1, 1])
check('1.3 PATCH 把状态、时刻、平台单号一起回填', [bodyAt(orderPatches()).status, bodyAt(orderPatches()).paid_at, bodyAt(orderPatches()).wx_order_id], ['paid', PAID_ISO, 'VPO-1'])
check('1.4 🔴 PATCH 的过滤条件是 status in (pending,closed)：重放挪不走已付单的 paid_at（7 天窗口起点）', urlAt(orderPatches()).includes('status=in.%28pending%2Cclosed%29'), true)
// 🔴 第二格才是这次的真判据：`in.()` 是 CSV 解析，值**不加引号**。上一版写成
//   `in.%28%27pending%27%2C%27closed%27%29`（带单引号）在真库上匹配 0 行，而当时的判据
//   恰好把那个错写法逐字钉住了——**判据绿着把 bug 保护了起来**。所以这里正面禁止单引号。
check('1.4b 🔴 值列表里不许出现单引号（CSV 形态；带引号那一版实测匹配 0 行＝E-19）', /%27|'/.test(urlAt(orderPatches()).split('status=in.')[1] || ''), false)
check('1.5 🔴 paid_time 是 unix 秒 ⇒ ×1000。忘了乘的症状是"1970 年到期"，零异常日志', bodyAt(orderPatches()).paid_at.slice(0, 4), PAID_ISO.slice(0, 4))
check('1.6 账本行的七个字段全部来自服务端（没有一样来自端上）', Object.keys(bodyAt(ledgerPosts()) === MISSING ? {} : ledgerPosts()[0].body).sort().join(','), ['buyer_user_id', 'duration_days', 'effective_at', 'env', 'order_id', 'payer_openid', 'provider'].sort().join(','))
check('1.7 🔴 账本行带 order_id＝订单主键。漏了它：unique 闸门失效（Postgres 允许多行 null）、B4 撤不掉、6.5 算成真单', bodyAt(ledgerPosts()).order_id, OID)
check('1.8 期限是商品表的快照（月卡 30 天），不是端上传的', bodyAt(ledgerPosts()).duration_days, 30)
check('1.9 effective_at ＝ 支付时刻，与订单行的 paid_at 同值', bodyAt(ledgerPosts()).effective_at, bodyAt(orderPatches()).paid_at)
check('1.10 env／payer_openid／buyer_user_id 都抄自订单行', [bodyAt(ledgerPosts()).env, bodyAt(ledgerPosts()).payer_openid, bodyAt(ledgerPosts()).buyer_user_id], [0, OPENID, UID])
check('1.11 时刻读得出来时**不**写 note（note 只留给异常）', bodyAt(orderPatches()).note, undefined)
check('1.12 durationDays 也回给调用方（端上确认态要显示"30 天"）', res.durationDays, 30)

// 1.13–1.15 🔴 E-23 判甲：三个单号各归各列。一手依据＝2026-10-05 那笔已付单的回包里
//   `wx_order_id`(VPO…)／`channel_order_id`(2026…)／`wxpay_order_id`(4500…) **同时存在且值不同**，
//   而后台"交易单号"那一列是第三个。旧代码那条 `wx_order_id ‖ channel_order_id ‖ wxpay_order_id`
//   回退链会在缺第一个时把**渠道单号**写进"平台侧订单号"那一列（它还挂着 partial unique）⇒ 撤掉。
check('1.13 🔴 交易单号落到自己那一列（不是塞进 wx_order_id、也不是不落）', bodyAt(orderPatches()).wxpay_order_id, '4500-1')
reset()
stub.queryBody = { errcode: 0, order: { status: 2, paid_time: PAID_SEC, channel_order_id: '2026-1', wxpay_order_id: '4500-9' } }
res = await credit()
check('1.14 🔴 缺 wx_order_id 时**不拿 channel_order_id 顶替**（那一列上不许出现语义不同的值）', ['wx_order_id' in bodyAt(orderPatches()), 'channel_order_id' in bodyAt(orderPatches())], [false, false])
check('1.15 同一次回包里 wxpay_order_id 照样落（两列各读各的字段，互不兜底）', bodyAt(orderPatches()).wxpay_order_id, '4500-9')
reset()
stub.queryBody = { errcode: 0, order: { status: 2, paid_time: PAID_SEC, wx_order_id: 'VPO-1' } }
res = await credit()
check('1.16 回包没有交易单号 ⇒ body 里干脆不出现这一列（不写 null 去覆盖已有值）', 'wxpay_order_id' in bodyAt(orderPatches()), false)

// ── 2. paid_time 的四种形状（换算错了不报错，只是权益短一大截）──────────────
reset()
res = await credit()
check('2.1 秒（文档实测那行）⇒ ×1000，得到的就是那个 unix 秒对应的时刻', bodyAt(orderPatches()).paid_at, PAID_ISO)
check('2.1b 🔴 反面对照：没乘 1000 会得到 1970-01-21（这一格红就是换算被改坏了）', bodyAt(orderPatches()).paid_at.startsWith('1970'), false)
reset()
stub.queryBody = { errcode: 0, order: { status: 2, paid_time: String(PAID_SEC) } }
res = await credit()
check('2.2 字符串秒也换算（PostgREST/JSON 混形状是常态，不猜类型）', bodyAt(orderPatches()).paid_at, PAID_ISO)
reset()
stub.queryBody = { errcode: 0, order: { status: 2, paid_time: PAID_SEC * 1000 } }
res = await credit()
check('2.3 万一平台给毫秒（>1e11）⇒ 不再乘（再乘得到 5.7 万年后）', bodyAt(orderPatches()).paid_at, PAID_ISO)
reset()
stub.queryBody = { errcode: 0, order: { status: 3 } }
res = await credit()
check('2.4 没有 paid_time ⇒ 仍入账（钱是实付的），时刻退到本次确认时刻', [res.outcome, Date.now() - Date.parse(bodyAt(orderPatches()).paid_at) < 5000], ['credited', true])
check('2.5 🔴 退来的时刻必须写进**数据**（note），不能只写日志：人工巡检读的是行，读不到某次部署的 console', bodyAt(orderPatches()).note, 'paid_time_missing:used_confirmation_time')
reset()
stub.queryBody = { errcode: 0, order: { status: 2, paid_time: 0 } }
res = await credit()
check('2.6 paid_time=0 走同一支（0 不是合法时刻）', bodyAt(orderPatches()).note, 'paid_time_missing:used_confirmation_time')

// ── 3. is_duplicate：只在"付款时已有 >20 天权益"时成立 ──────────────────────
const dupFlag = () => bodyAt(orderPatches()).is_duplicate
reset()
stub.coverageBody = { is_covered: true, valid_until: null, remaining_days: 25 }
res = await credit()
check('3.1 剩余 25 天时又付一笔 ⇒ is_duplicate true，且落进**订单行**（B4 靠它把这类划出额度）', [res.isDuplicate, dupFlag()], [true, true])
reset()
stub.coverageBody = { is_covered: true, valid_until: null, remaining_days: 19 }
res = await credit()
check('3.2 剩 19 天（本来就该能买）⇒ false，且不写这一列（默认值就是 false）', [res.isDuplicate, dupFlag()], [false, undefined])
reset()
stub.coverageBody = { is_covered: false, valid_until: null, remaining_days: null }
res = await credit()
check('3.3 无权益（null）⇒ false（E-7 同口径：null 不等于"剩余无限"）', res.isDuplicate, false)
reset()
stub.coverageStatus = 500
res = await credit()
check('3.4 🔴 余量读不到 ⇒ 照样入账（钱已付实），只是 is_duplicate 留 false。绝不能因这次读失败拒绝发货', [res.outcome, ledgerPosts().length], ['credited', 1])

// ── 4. 五档"不动库"：查单说没付／查不到／判不出 ────────────────────────────
const noWrite = async (queryBody) => {
  reset()
  stub.queryBody = queryBody
  const out = await credit()
  return [out.outcome, writes().length]
}
check('4.1 status 1（未付）⇒ unpaid，零写', await noWrite({ errcode: 0, order: { status: 1 } }), ['unpaid', 0])
check('4.2 status 0（未支付）⇒ unpaid，零写', await noWrite({ errcode: 0, order: { status: 0 } }), ['unpaid', 0])
check('4.3 status 6（已关闭）⇒ closed，零写', await noWrite({ errcode: 0, order: { status: 6 } }), ['closed', 0])
check('4.4 status 5（已退款）⇒ refunded，零写（退了的钱不换权益）', await noWrite({ errcode: 0, order: { status: 5 } }), ['refunded', 0])
check('4.5 268490002（查无此单）⇒ not_found，零写', await noWrite({ errcode: 268490002, errmsg: '数据不存在' }), ['not_found', 0])
check('4.6 🔴 没见过的 status ⇒ query_error，**不许当未付**（未付＝可以关单/答成功）', await noWrite({ errcode: 0, order: { status: 99 } }), ['query_error', 0])
check('4.7 268490003 签名错误 ⇒ query_error，零写', await noWrite({ errcode: 268490003, errmsg: '签名错误' }), ['query_error', 0])
check('4.8 7 退款失败 ⇒ error 档（不猜），零写', await noWrite({ errcode: 0, order: { status: 7 } }), ['query_error', 0])
reset()
stub.queryThrows = true
res = await credit()
check('4.9 网络抛错 ⇒ query_error 且零写：这是"查单失败 ≠ 未付"最真实的一次抖动', [res.outcome, writes().length], ['query_error', 0])
reset()
stub.tokenBody = { errcode: 40013, errmsg: 'invalid appid' }
res = await credit()
check('4.10 取不到 token ⇒ query_error、根本没打到 query_order（省一次无谓出网）', [res.outcome, queryCalls().length], ['query_error', 0])

// ── 5. 本地行的状态决定要不要出网（幂等重放与"两步写"修复）───────────────────
reset()
stub.orderRows = []
res = await credit()
check('5.1 库里没这单 ⇒ no_local_order 且🔴一次 xpay 都不打（单号可能是端上拼错的）', [res.outcome, queryCalls().length, writes().length], ['no_local_order', 0, 0])

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.ledgerRows = [{ id: 'l-1' }]
res = await credit()
check('5.2 已付＋账本在 ⇒ already，不查单、不写（端上轮询到这一格就该停）', [res.outcome, res.repaired, queryCalls().length, writes().length], ['already', false, 0, 0])

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.ledgerRows = []
res = await credit()
check('5.3 已付但账本缺（两步写被打断过）⇒ 补上，且不查单', [res.outcome, res.repaired, queryCalls().length], ['credited', true, 0])
check('5.4 🔴 补写用的时刻是**行里的 paid_at**，不是"补的这一刻"（否则 7 天窗口起点被挪后）', bodyAt(ledgerPosts()).effective_at, PAID_ISO)
check('5.5 补写的行同样带 order_id（补的那行也必须可撤）', bodyAt(ledgerPosts()).order_id, OID)

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: null })
res = await credit()
check('5.6 paid 却没有 paid_at（库侧 CHECK 本该挡住的形状）⇒ bad_order，不猜时刻、不入账', [res.outcome, res.reason, writes().length], ['bad_order', 'paid_without_paid_at', 0])

reset()
stub.orderRow = orderRow({ status: 'refunded', paid_at: PAID_ISO })
stub.ledgerRows = [{ id: 'l-1' }]
res = await credit()
check('5.7 已退款单＋账本在 ⇒ already（退款不重查平台，撤销由 B4 的账本 revoked_at 负责）', [res.outcome, queryCalls().length], ['already', 0])

reset()
stub.orderRow = orderRow({ status: 'closed' })
res = await credit()
check('5.8 我方已 closed、平台说付了 ⇒ 入账，并把 paid_after_close 落列（不落就统计不到）', [res.outcome, bodyAt(orderPatches()).paid_after_close], ['credited', true])
check('5.9 closed 能进这道闸，靠的是 PATCH 过滤里带着 closed（CSV 形态、不带引号＝E-19 之后）', urlAt(orderPatches()).includes('status=in.%28pending%2Cclosed%29'), true)

// 🔴 E-17 判丙之后 `anomaly` 这一档从"只可能人工写"变成"我方代码会写"（平台已退款而我方未入账），
//   于是 4.5 第 3 步那句"拒绝复活"第一次有了真实的入口：任何自动触发源都不许把它读成"再查一次就发了"。
reset()
stub.orderRow = orderRow({ status: 'anomaly', anomaly_reason: 'refunded_not_credited' })
res = await credit()
check('5.10 anomaly 单 ⇒ anomaly_held：不查平台、不写库（出边只有人工，且必须留 operator/note）', [res.outcome, res.reason, queryCalls().length, writes().length], ['anomaly_held', 'refunded_not_credited', 0, 0])
reset()
stub.orderRow = orderRow({ status: 'anomaly', anomaly_reason: null })
res = await credit()
check('5.11 没有 anomaly_reason 的 anomaly 行同样拒绝复活（reason 回 null，不猜）', [res.outcome, res.reason], ['anomaly_held', null])

// ── 6. 幂等与半失败 ────────────────────────────────────────────────────────
reset()
stub.ledgerInsertStatus = 409
stub.ledgerInsertError = conflictBody
res = await credit()
check('6.1 账本撞 order_id unique ⇒ already，是**成功**不是错误（报 500 会让人再买一次）', [res.outcome, ledgerPosts().length], ['already', 1])

reset()
stub.patchStatus = 500
res = await credit()
check('6.2 订单状态没改成 ⇒ 🔴 账本不写（否则出现"有权益但订单挂着 pending"的形状），留在 pending 等下一轮', [res.outcome, res.stage, ledgerPosts().length], ['query_error', 'mark_paid', 0])

// 6.2b/6.2c 🔴 2026-10-05 真机那一条：**HTTP 200 不等于改到了行**。PostgREST 不带
//   `Prefer: return=representation` 时，PATCH 改 0 行与改 1 行回的都是空 body ⇒ 旧代码会把
//   "WHERE 没匹配上"读成"入账成功"，于是出现"账本行写进去了、订单还是 pending"（症状：订单页
//   永远待支付、7 天退款窗口没有起点、A3/A4 巡检看不见这笔）。现在要求它把行回回来。
reset()
stub.patchRows = []
res = await credit()
check('6.2b 🔴 PATCH 回 200 但零行 ⇒ 同样按"没改成"处理：query_error、账本零写、订单留在 pending', [res.outcome, res.stage, ledgerPosts().length], ['query_error', 'mark_paid', 0])
reset()
await credit()
check('6.2c 这条 PATCH 确实带了 return=representation（不带就没有 6.2b 那道判据）', bodyAt(orderPatches()) !== MISSING && orderPatches()[0].headers.Prefer, 'return=representation')

reset()
stub.ledgerInsertStatus = 500
stub.ledgerInsertError = { message: 'ledger boom' }
res = await credit()
check('6.3 非冲突的账本写失败 ⇒ query_error（让调用方应答失败、平台继续重推）', [res.outcome, res.stage], ['query_error', 'ledger_insert'])
reset()
stub.ledgerRows = []
stub.ledgerReadStatus = 500
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
res = await credit()
check('6.4 账本"在不在"读不出来 ⇒ query_error 且**不硬插**（硬插可能插出第二行权益）', [res.outcome, res.stage, writes().length], ['query_error', 'ledger_read', 0])

reset()
stub.orderRow = orderRow({ product_id: 'ghost_product' })
res = await credit()
check('6.5 查得已付但商品表里没这个 id ⇒ product_missing，零写（期限是权益本体，猜一个数＝凭空发权益）', [res.outcome, writes().length], ['product_missing', 0])
reset()
stub.orderRow = orderRow({ payer_openid: null })
res = await credit()
check('6.6 行里没 payer_openid ⇒ bad_order 且不打平台（接口必填 openid）', [res.outcome, res.reason, queryCalls().length], ['bad_order', 'no_payer_openid', 0])
reset()
stub.orderRow = orderRow({ id: null })
res = await credit()
check('6.7 🔴 行里读不到主键 ⇒ bad_order 零写。这一格钉的是"账本行漏 order_id"那类失误：宁可停在 pending', [res.outcome, res.reason, writes().length], ['bad_order', 'no_order_id', 0])
reset()
let threw = null
try {
  await insertLedgerRow(env(), { provider: 'wechat_mp', payer_openid: OPENID, effective_at: PAID_ISO, duration_days: 30 })
} catch (err) {
  threw = err.code
}
check('6.8 🔴 写入口自己拦：少 order_id 直接抛，不出网（四个调用方不可能都记得）', [threw, ledgerPosts().length], ['pro_ledger_row_incomplete', 0])

// ── 6b. 发货告知（E-20①：入账成功当场把"货已发"推给平台）────────────────────
// 这一节钉的是**调用时机**，不是接口形状（形状只能等真单，见验收 #71）。两个方向的失误都 real：
// 多打＝每一轮轮询都多两次出网；少打＝平台侧长期挂"未发货"（2026-10-05 真机第一轮正是这一格空着，
// 那一笔付成功的单在后台一直显示未发货，而 owner 就是从那一屏发现我们能被后台直接退款的）。
reset()
res = await credit()
{
  const ledgerIdx = calls.findIndex((c) => c.url.includes('/rest/v1/pro_ledger') && c.method === 'POST')
  const notifyIdx = calls.findIndex((c) => c.url.includes('/xpay/notify_provide_goods'))
  check('6b.1 入账成功 ⇒ 恰好一次发货告知', [res.outcome, notifyCalls().length], ['credited', 1])
  check('6b.2 🔴 它在账本写成功**之后**（反过来＝把没发成的权益报告成已发货，平台那边就再也看不出这是笔要追的单）', [ledgerIdx >= 0, notifyIdx > ledgerIdx], [true, true])
}
check('6b.3 body 只有 order_id＋env，order_id＝我方下单时的单号（不是 wx_order_id：页面写的是"下单时传的单号"）', [Object.keys(bodyAt(notifyCalls())).sort().join(','), bodyAt(notifyCalls()).order_id], ['env,order_id', NO])
check('6b.4 走的是同一条签名通道（URL 里有 pay_sig ⇒ 不是另起一份不签名的出网代码）', urlAt(notifyCalls()).includes('pay_sig=') && urlAt(notifyCalls()).includes('access_token='), true)
check('6b.5 发的 env＝接口的 0/1（0 现网），不是库里的 env_type 1/2', bodyAt(notifyCalls()).env, 0)
reset()
stub.notifyBody = { errcode: 48001, errmsg: 'api unauthorized' }
res = await credit()
check('6b.6 🔴 平台拒了这次发货 ⇒ 入账结论仍是 credited，且零额外写（权益由我方账本决定，不靠平台那一格）', [res.outcome, orderPatches().length, ledgerPosts().length, notifyCalls().length], ['credited', 1, 1, 1])
reset()
stub.notifyThrows = true
res = await credit()
check('6b.7 告知这一步网络抛错 ⇒ 仍 credited、不回滚（creditOrder 绝不因它变成 500——500 会让端上再买一次）', [res.outcome, writes().length], ['credited', 2])
check('6b.8 失败**不重试**（四笔账：一次购买对平台的发货调用上限就是 1 次；补做交后台，不在支付路径里加出网）', notifyCalls().length, 1)
reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.ledgerRows = [{ id: 'l-1' }]
res = await credit()
check('6b.9 🔴 already（第二次问到同一笔已付单）⇒ 不打发货，否则 6 轮轮询＝6 次无谓出网', [res.outcome, notifyCalls().length], ['already', 0])
reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.ledgerRows = []
res = await credit()
check('6b.10 补写成功（两步写被打断后补上那一行）⇒ 同样打一次：权益当场成立，发货就该跟上', [res.outcome, res.repaired, notifyCalls().length], ['credited', true, 1])
reset()
stub.orderRow = orderRow({ status: 'refunded', paid_at: PAID_ISO })
stub.ledgerRows = []
res = await credit()
check('6b.11 已退的单即便补了账本也**不**打发货（给退回来的钱点"已发货"，方向与 B4 的撤账口径相反）', [res.outcome, notifyCalls().length], ['credited', 0])
reset()
stub.orderRow = orderRow({ status: 'anomaly', anomaly_reason: 'refunded_not_credited' })
res = await credit()
check('6b.12 anomaly ⇒ 不打（拒绝复活那条规矩在发货这一侧同样成立）', [res.outcome, notifyCalls().length], ['anomaly_held', 0])
const notifyFor = async (queryBody) => {
  reset()
  stub.queryBody = queryBody
  const out = await credit()
  return [out.outcome, notifyCalls().length]
}
check('6b.13 查得未付 ⇒ 不打', await notifyFor({ errcode: 0, order: { status: 1 } }), ['unpaid', 0])
check('6b.14 查得已关 ⇒ 不打', await notifyFor({ errcode: 0, order: { status: 6 } }), ['closed', 0])
check('6b.15 查得已退 ⇒ 不打', await notifyFor({ errcode: 0, order: { status: 5 } }), ['refunded', 0])
check('6b.16 查无此单 ⇒ 不打', await notifyFor({ errcode: 268490002, errmsg: '数据不存在' }), ['not_found', 0])
check('6b.17 判不出（签名错）⇒ 不打', await notifyFor({ errcode: 268490003, errmsg: '签名错误' }), ['query_error', 0])
reset()
stub.ledgerInsertStatus = 500
stub.ledgerInsertError = { message: 'ledger boom' }
res = await credit()
check('6b.18 🔴 账本没写成 ⇒ 不打发货（6b.2 那格只有在这一支也红时才算真的有牙）', [res.outcome, notifyCalls().length], ['query_error', 0])
reset()
stub.patchRows = []
res = await credit()
check('6b.19 订单状态没改成（200 但零行＝E-19 那一格）⇒ 不打发货', [res.outcome, res.stage, notifyCalls().length], ['query_error', 'mark_paid', 0])
reset()
stub.orderRow = orderRow({ env: 1 })
res = await credit()
check('6b.20 沙箱行（env=1）⇒ 查单与发货都按接口的 env=1 发（不拿现网凭证去发沙箱货，也不反过来）', [bodyAt(queryCalls()).env, bodyAt(notifyCalls()).env], [1, 1])
// 以下四格直接打 `xpayNotifyProvideGoods`：接口页写「返回参数：无」⇒ **"成功"的判据形状**必须自己定，
// 而严格判 `errcode === 0` 会把每一次真发货都记成失败（回的是空 body 时 errcode 根本不存在）。
reset()
stub.notifyBody = null // HTTP 200＋body 不是 JSON
let n = await xpayNotifyProvideGoods({ env: env(), orderId: NO })
check('6b.21 200＋空/非 JSON body ⇒ 按成功读（页面「返回参数：无」那一档）', [n.status, n.ok], [200, true])
reset()
stub.notifyBody = {}
n = await xpayNotifyProvideGoods({ env: env(), orderId: NO })
check('6b.22 200＋`{}`（没有 errcode 字段）⇒ 同样按成功读', n.ok, true)
reset()
stub.notifyStatus = 500
n = await xpayNotifyProvideGoods({ env: env(), orderId: NO })
check('6b.23 HTTP 500（哪怕 body 里还写着 errcode 0）⇒ 按失败读：status 与 errcode 要同时成立', [n.ok, n.errcode], [false, 0])
reset()
stub.tokenStatus = 400
n = await xpayNotifyProvideGoods({ env: env(), orderId: NO })
check('6b.24 取不到 token ⇒ 失败且根本没打到接口', [n.ok, notifyCalls().length], [false, 0])
reset()
n = await xpayNotifyProvideGoods({ env: env(), orderId: '' })
check('6b.25 缺单号 ⇒ 不出网（接口必填"下单时传的单号"）', [n.ok, notifyCalls().length], [false, 0])

// ── 7. queryOrderState：下单前置④用，只读平台、一律不写 ─────────────────────
reset()
res = await queryOrderState(env(), orderRow())
check('7.1 已付 ⇒ paid', res.outcome, 'paid')
reset()
res = await queryOrderState(env(), orderRow({ env: 1 }))
check('7.2 🔴 查单 env 跟**订单行**走（沙箱单要按沙箱查），不跟部署常量', [bodyAt(queryCalls()).env, res.outcome], [1, 'paid'])
reset()
stub.queryBody = { errcode: 0, order: { status: 5 } }
res = await queryOrderState(env(), orderRow())
check('7.3 平台说已退款 ⇒ refunded（下单侧据此既不关也不建）', [res.outcome, writes().length], ['refunded', 0])
const stateNoWrite = async (queryBody) => {
  reset()
  stub.queryBody = queryBody
  const out = await queryOrderState(env(), orderRow())
  return [out.outcome, out.via || null, writes().length]
}
check('7.4 未付 ⇒ unpaid，零写', await stateNoWrite({ errcode: 0, order: { status: 1 } }), ['unpaid', 'unpaid', 0])
check('7.5 已关闭 ⇒ 归进可建新单那一档（via 留原档）', await stateNoWrite({ errcode: 0, order: { status: 6 } }), ['unpaid', 'closed', 0])
check('7.6 查无此单 ⇒ 归进可建新单那一档（假单号/从未付过）', await stateNoWrite({ errcode: 268490002 }), ['unpaid', 'not_found', 0])
check('7.7 判不出 ⇒ query_error（下单侧据此 503 且不关不建）', await stateNoWrite({ errcode: 268490003 }), ['query_error', null, 0])
reset()
stub.queryBody = { errcode: 0, order: { status: 2 } }
await queryOrderState(env(), orderRow())
check('7.8 🔴 本函数一次库都没写（它只回答"付了没"，入账是 creditOrder 的事）', writes().length, 0)

// ── 8. GET /api/pro/orders/:no：端上确认态轮询 ──────────────────────────────
const runGet = async (no = NO, eover = {}, dataOver = null) => {
  const res = await onRequestGet({
    request: new Request('https://cf/api/pro/orders/' + encodeURIComponent(no), { method: 'GET' }),
    params: { no: encodeURIComponent(no) },
    env: env(eover),
    data: dataOver === null ? { user: { id: UID } } : dataOver,
  })
  return { status: res.status, body: await res.json() }
}
reset()
res = await runGet()
check('8.1 pending＋新鲜＋开关开 ⇒ 查单并当场入账', [res.status, res.body.status, res.body.credited, res.body.queryOutcome], [200, 'paid', true, 'credited'])
check('8.2 回给端上的字段就是确认态要的那几个（白名单，不加不减）', Object.keys(res.body).sort().join(','), ['credited', 'durationDays', 'goodsPrice', 'outTradeNo', 'paidAt', 'productId', 'queryOutcome', 'queried', 'status'].sort().join(','))
check('8.3 🔴 响应里没有 payer_openid／user_id／note／callback_raw（4.6 行级策略拦不住列）', ['openid', 'user_id', 'note'].some((k) => JSON.stringify(res.body).includes(k)), false)
check('8.4 时长与单价从商品表补（表里没这两列）', [res.body.durationDays, res.body.goodsPrice], [30, 333])

reset()
stub.orderRow = orderRow({ status: 'paid', paid_at: PAID_ISO })
stub.ledgerRows = [{ id: 'l-1' }]
res = await runGet()
check('8.5 已经 paid 的单⇒不打平台（queried:false），省 token 配额', [res.body.status, res.body.queried, res.body.queryOutcome, queryCalls().length], ['paid', false, 'already_settled', 0])

reset()
stub.orderRow = orderRow({ created_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() })
res = await runGet()
check('8.6 🔴 pending 但超 24 小时⇒不再催平台（四笔账里的频次上限），交 6.5 人工巡检', [res.body.status, res.body.queryOutcome, queryCalls().length], ['pending', 'not_queried', 0])

reset()
stub.orderRow = orderRow({ created_at: 'not-a-date' })
res = await runGet()
check('8.7 created_at 读不出⇒按"不新鲜"处理（不给来路不明的单反复打平台）', queryCalls().length, 0)

reset()
res = await runGet(NO, { PRO_PURCHASE_ENABLED: 'false' })
check('8.8 购买闸关着⇒读得出单但不查单不入账（关态不许有任何发货动作）', [res.status, res.body.status, queryCalls().length], [200, 'pending', 0])

reset()
stub.orderRow = orderRow({ user_id: 'u-deleted-after-merge' })
res = await runGet()
check('8.9 🔴 归属只看 payer_openid：访客合并后 user_id 指向已删行，刚买完的人仍要看得到自己那张单', [res.status, res.body.outTradeNo], [200, NO])
reset()
stub.orderRow = orderRow({ payer_openid: 'oSomeoneElse' })
res = await runGet()
check('8.10 openid 对不上⇒404，且🔴**打平台之前**就判完归属（不替别人的单号去查平台）', [res.status, res.body.code, queryCalls().length], [404, 'no_such_order', 0])
reset()
stub.identityRows = []
res = await runGet()
check('8.11 这个账号没绑微信⇒404（不是 403：存在性本身也是别人的信息）', [res.status, res.body.code], [404, 'no_such_order'])

reset()
stub.queryBody = { errcode: 0, order: { status: 1 } }
res = await runGet()
check('8.12 查得未付⇒status 仍 pending、不报失败（6.4：报失败会让人再付一遍）', [res.body.status, res.body.credited, res.body.queryOutcome], ['pending', false, 'unpaid'])
reset()
stub.queryBody = { errcode: 268490003 }
res = await runGet()
check('8.13 查单判不出⇒同样保持 pending（端上会继续等到轮询上限，不会显示成功也不会显示失败）', [res.body.status, res.body.queryOutcome], ['pending', 'query_error'])

reset()
stub.orderReadStatus = 500
res = await runGet()
check('8.14 订单读失败⇒503 且没打平台', [res.status, res.body.code, queryCalls().length], [503, 'pro_unavailable', 0])
reset()
res = await runGet('', {}, { user: { id: UID } })
check('8.15 空单号⇒400', [res.status, res.body.code], [400, 'bad_request'])
reset()
res = await runGet(NO, {}, {})
check('8.16 没有会话身份⇒401 且零出网', [res.status, calls.length], [401, 0])

// ── 8.17…8.24 甲′（E-41）：平台亲口答"已关闭"就当场把这行写成 closed ─────────────
// 🔴 这一族判的核心不是"能不能写"，而是**哪三种答案不许写**：`not_found` 与 `unpaid` 都还是"说不准"，
//   把它们写成 `closed` ＝拿"平台没记录／还开着"冒充"平台判过死"，而 `closed` 的语义是"没付过"。
reset()
stub.queryBody = { errcode: 0, order: { status: 6 } }
res = await runGet()
check('8.17 🔴 平台答"已关闭"⇒ 库里写成 closed、响应也回 closed（刚取消的单不该再挂着「待支付」给人看）',
  [res.body.status, res.body.queryOutcome, res.body.credited], ['closed', 'closed', false])
check('8.18 那一次 PATCH 带 status=eq.pending（与推送撞上时匹配 0 行，绝不把已付单改回未付）',
  urlAt(orderPatches()).includes('status=eq.pending'), true)
check('8.19 只写这一行：零账本、零发货告知（closed 不是入账）',
  [orderPatches().length, ledgerPosts().length, notifyCalls().length], [1, 0, 0])

reset()
stub.queryBody = { errcode: 0, order: { status: 6 } }
stub.patchRows = [] // 有人先把这行记成 paid ⇒ 我们那次 PATCH 匹配 0 行
// 🔴 队列是**三次**读，不是两次：这一条链上一共读三回——① 端点按单号取行、② `creditOrder` 自己又读一次
//   （它只认库里的行，不接调用方传进来的行）、③ 写不成之后重读。前两次都要给 pending，否则 ② 一读到 paid
//   就直接走"补账本"那一支，回的是 `credited` 而不是 `closed`，这一格测的就不再是那个并发窗口了。
//   （第一版我就这么读错过一次：got 是 ["paid","credited"]，症状对、场景错。）
stub.orderRowQueue = [orderRow(), orderRow(), orderRow({ status: 'paid', paid_at: PAID_ISO })]
res = await runGet()
check('8.20 🔴 反向：匹配 0 行时**重读一次再报**，回 paid——绝不能对已付的人说"已取消，没有扣款"',
  [res.body.status, res.body.queryOutcome, ledgerPosts().length], ['paid', 'closed', 0])

reset()
stub.queryBody = { errcode: 268490002, errmsg: '数据不存在' }
res = await runGet()
check('8.21 🔴 查无此单**不**写成 closed（订单是"拉起收银台那一刻"才在平台侧存在的，从没拉起本来就查不到）',
  [res.body.status, res.body.queryOutcome, orderPatches().length], ['pending', 'not_found', 0])

reset()
stub.queryBody = { errcode: 0, order: { status: 1 } }
res = await runGet()
check('8.22 平台答"未付"（status 0/1 还开着）⇒ 不写 closed，那张单还付得进去',
  [res.body.status, orderPatches().length], ['pending', 0])

reset()
stub.orderRow = orderRow({ status: 'closed' })
res = await runGet()
check('8.23 已经是 closed 的行⇒不打平台也不再 PATCH（四笔账里的频次：这一支只对"pending 且新鲜"生效）',
  [res.body.status, res.body.queried, orderPatches().length, queryCalls().length], ['closed', false, 0, 0])

// 🔴 静态那一半（"写 closed 只许在 proStore 一处"）挪到第 9 节的 9.9——`JS`／`read` 那两个 helper
//   在第 9 节才定义，放在这里会 ReferenceError 把整张表崩掉（崩一次就一个红格都看不见，
//   这条纪律本仓已记过：缺定义要红，不该崩）。

// ── 9. 静态闸：4.6 的"唯一写模块"与 6.2 的"只认查单" ────────────────────────
const JS = []
;(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.js')) JS.push(p)
  }
})(path.join(root, 'functions'))
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
// `outside(re, owner)` ＝ "这条形状只允许出现在 owner 这个模块里"，列出其余命中文件。
const outside = (re, owner = 'proStore.js') => JS.filter((p) => !p.includes(owner) && re.test(read(p))).map((p) => path.relative(root, p))
check('9.1 🔴 三张会员表的 URL 只出现在 proStore.js（端点里不许各写一份 serviceRoleFetch）', outside(/rest\/v1\/pro_(orders|ledger|refund_requests)/), [])
check('9.2 只有 proStore 写 status:paid', outside(/status:\s*'paid'/), [])
// 第四个消费者＝B5① 管理端出边（`functions/admin/pro-anomaly.js`）。它调 `creditOrder` 是**刻意**的：
// 全仓只许有一份"查单→回填 paid→写账本→发货告知"。它凭什么算安全（三处判据，别只信这句注释）：
//   · 交还前那一行**一定已经是 `pending`**（先做一次带 `status=eq.<原状态>` 的 CAS）⇒ 上面
//     "anomaly 拒绝复活"那道门从没被绕过（`test:anomaly` 4.1／4.2／4.12）；
//   · 它自己不写 paid、不写账本行（`test:anomaly` 8.2 的 import 清单＋本文件 9.1／9.2）；
//   · `proCredit.js` 里不许出现 `allowAnomaly`／`isAdmin` 这类为管理端开的口子（`test:anomaly` 8.3／8.4）。
check('9.3 入账实现只有一个模块（proCredit 之外没人 import 它）——消费者清单是**封闭列表**，加第四个要在这里登记', JS.filter((p) => /from '.*proCredit/.test(read(p)) && !p.includes('proCredit.js')).map((p) => path.relative(root, p)).sort(), ['functions\\api\\pro\\orders\\index.js', 'functions\\api\\pro\\orders\\[no].js', 'functions\\push\\xpay.js', 'functions\\admin\\pro-anomaly.js'].sort())
check('9.4 🔴 proCredit 不 import 签名模块⇒入账这条链上不碰 session_key／一次性 code', /proPaySign/.test(read(path.join(root, 'functions/_lib/proCredit.js'))), false)
check('9.5 creditOrder 只在 proCredit 里定义一次', JS.filter((p) => /export async function creditOrder/.test(read(p))).length, 1)
check('9.6 🔴 打 `/xpay/*` 的调用点只有 proXpay.js 一处（别人不许绕过分类器自己发、自己读 status）', outside(/uri:\s*'\/xpay\//, 'proXpay.js'), [])
check('9.7 "已付/未付"的数值判定只发生在 classifyQueryResult 里一处', JS.filter((p) => /Number\(order\.status\)/.test(read(p))).map((p) => path.relative(root, p)), ['functions\\_lib\\proXpay.js'])
check('9.8 🔴 发货告知只有一个调用方（proCredit）⇒ 端点里不许出现第二个"我认为该发货了"的实现', JS.filter((p) => /xpayNotifyProvideGoods/.test(read(p))).map((p) => path.relative(root, p)).sort(), ['functions\\_lib\\proCredit.js', 'functions\\_lib\\proXpay.js'])
// 甲′（E-41）静态那一半：写 `status:'closed'` 这个动作只许在 proStore（端点调 closePendingOrder）。
// ⚠️ 期望里那两个是**真实形状**，不是"我以为只有两个"：`admin/pro-anomaly.js` 那一处命中的是它
//   **响应体**里的 `status: 'closed'`（把收口结果回给调用方），不是写库——所以这条门管的是"新增写库点"，
//   它不是一句恒真：任何第三处出现都会红。（拿 `body: { status: 'closed'` 当锚点更严，但一改格式就假红。）
check('9.9 🔴 出现 `status: \'closed\'` 的文件只有 proStore（写库）与 pro-anomaly（响应体）两处',
  JS.filter((p) => /status:\s*'closed'/.test(read(p))).map((p) => path.relative(root, p).replace(/\\/g, '/')).sort(),
  ['functions/_lib/proStore.js', 'functions/admin/pro-anomaly.js'])

const failed = results.filter((x) => !x.ok)
for (const x of failed) console.log(`✗ ${x.name}\n    got  ${JSON.stringify(x.got)}\n    want ${JSON.stringify(x.want)}`)
console.log(`${results.length - failed.length}/${results.length} 格通过`)
if (failed.length) process.exitCode = 1
