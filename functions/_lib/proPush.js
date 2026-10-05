// 入站消息推送（微信 → 我们）的**验签、报文解析与应答**——唯一一份实现（PRD v3 4.5 第 1 条、E-20②）。
//
// 为什么单独一个模块：验签算法与"应答什么算失败"是**同一条通道的两半**，散在端点里就会长成
// 两份不完全一样的判断——而这类代码最经典的失手形状就是"其中一份静默放过坏签名"。
//
// 🔴 形状来源与未证的部分（写在这里，别让后来人以为这是逐字核过的）：
//   · 验签／URL 校验：通用文档树 `framework/server-ability/message-push.html`（2026-10-05 工具抓取，
//     原话进正本附录甲）——`signature` ＝ sha1(字典序 sort(Token, timestamp, nonce) 拼接)，
//     GET 校验通过要**原样返回 `echostr`**。
//   · 虚拟支付的事件名与字段表：`Event`／`OpenId`／`OutTradeNo`／`WeChatPayInfo.MchOrderNo`／
//     `GoodsInfo.ProductId`／`GoodsInfo.Quantity`，应答体 `<xml><ErrCode>0</ErrCode>
//     <ErrMsg><![CDATA[success]]></ErrMsg></xml>`，重推上限 15 次——**个人版页的工具抓取**。
//     🔴 其中 `xpay_goods_deliver_notify` 这个名字只有工程稿给过（`xpay_refund_notify` 官方页有）。
//   · 加密方式与数据格式由 owner 2026-10-05 定＝**明文 ＋ XML** ⇒ 本模块不解密、不读 JSON。
//     将来若改"安全模式"，要补的是 `msg_signature` 校验 ＋ AES-256-CBC 解 `Encrypt`（那一页
//     写的形状：`AESKey=Base64Decode(EncodingAESKey+"=")`、明文＝`random(16)+msg_len(4)+msg+appid`
//     且要验末尾 appid）——🔴 那是另一个批次的活，别在这里"顺手加个分支"。
//   ⇒ 所以失败方向是刻意的：**认不出的事件名一律当"处理不了"**（应答失败让平台继续重推），
//     并把原文截一段打进日志——第一次真推就是它的取证机会，而不是靠猜字段名上线。
//
// 🔴 两条不可省的边界：
// 1. **验签只是"这条请求值不值得处理"，不是入账依据**（4.5 第 1 条）：本模块不写库、不查平台。
//    事实确认在 `proCredit.creditOrder`／`proCredit.refundOrder`，它们只认 `query_order`。
// 2. **验签不过时绝不写库**（正本 §十六 E-25 登记，与 4.5 那张三态表第三行的原写法不同）：
//    原表写"记 `anomaly_reason='sign_invalid'`"，可"记"要先知道是哪张单——而单号来自同一条
//    不可信的报文。允许未验签的输入触发写库 ＝ 任何人拿我们的 URL 就能刷 `anomaly` 行
//    （A3 巡检列表变成别人的写入目标）。⇒ 现行：应答失败 ＋ 只打日志，🔴 不落任何库侧状态。

const TEXT_ENCODER = new TextEncoder()

// 顶层字段白名单：🔴 只读这些名字，其余一概不解析（不写通用 XML 解析器＝少一个能吃畸形输入的面）
// ✅ 2026-10-05 第一次真推（三条 `xpay_refund_notify`，正本附录甲有原文）到手后按实回包补齐：
//   退款那一支的单号字段**不是** `OutTradeNo`，而是 `MchOrderId`（商户单号＝我们的 `out_trade_no`），
//   另有 `WxOrderId`（＝`wx_order_id`）／`WxRefundId`／`MchRefundId`／`RefundFee`（分）／`RetCode`／`RetMsg`。
//   ⇒ 两个名字都收（`OutTradeNo` 是个人版页对**发货**推送那一列的转述，我们还没见过真发货推送）。
const TOP_FIELDS = [
  'ToUserName', 'FromUserName', 'CreateTime', 'MsgType', 'Event',
  'OpenId', 'OutTradeNo', 'MchOrderId', 'WxOrderId', 'Env',
  'WxRefundId', 'MchRefundId', 'RefundFee', 'RetCode', 'RetMsg',
  'WeChatPayInfo', 'GoodsInfo',
]
const NESTED = { WeChatPayInfo: ['MchOrderNo'], GoodsInfo: ['ProductId', 'Quantity'] }

// 两个事件名（发货那一个未逐字证，见文件头）
export const EVENT_DELIVER = 'xpay_goods_deliver_notify'
export const EVENT_REFUND = 'xpay_refund_notify'

async function sha1Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-1', TEXT_ENCODER.encode(text))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 定长比较：签名是攻击者可控输入，逐字符短路比较会按时序泄漏前缀 */
function hexEqual(a, b) {
  const x = String(a).toLowerCase()
  const y = String(b).toLowerCase()
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i)
  return diff === 0
}

/**
 * 明文模式的签名校验：`sha1(sort(Token, timestamp, nonce).join(''))`。
 * 🔴 四个入参任一缺失就回 false（不"当它没带所以放过"）；Token 没配由路由先挡成 503，
 *   走不到这里——所以这里的 false 一定意味着"这条请求不该被处理"，不是"配置没读到"。
 */
export async function verifyPushSignature({ token, timestamp, nonce, signature }) {
  if (!token || !timestamp || !nonce || !signature) return false
  const joined = [String(token), String(timestamp), String(nonce)].sort().join('')
  let mine = ''
  try {
    mine = await sha1Hex(joined)
  } catch {
    return false // crypto 不可用＝判不出，绝不是"放过"
  }
  return hexEqual(mine, signature)
}

function unwrap(raw) {
  const v = String(raw).trim()
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v)
  return (cdata ? cdata[1] : v).trim()
}

function pick(text, name) {
  // 名字来自上面两份白名单常量，不是外部输入 ⇒ 这里的拼接不构成注入面
  const m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(text)
  return m ? unwrap(m[1]) : null
}

/**
 * 读出白名单字段（XML，明文模式）。读不到就是 null——🔴 不做"看起来像就当成是"的兜底，
 * 调用方缺 `outTradeNo` 会直接应答失败（宁可让平台重推，也不要拿一条读不出的报文去改状态）。
 */
export function readPushFields(text) {
  const body = String(text || '')
  const flat = {}
  for (const name of TOP_FIELDS) {
    const v = pick(body, name)
    if (v !== null) flat[name] = v
  }
  for (const parent of Object.keys(NESTED)) {
    const block = flat[parent]
    if (block === undefined) continue
    for (const child of NESTED[parent]) {
      const v = pick(block, child)
      if (v !== null) flat[`${parent}.${child}`] = v
    }
  }
  return {
    event: flat.Event || null,
    // 🔴 单号有两个 spelled：真推来的是 `MchOrderId`（商户单号＝我们的 `out_trade_no`），
    //   个人版页对发货推送写的是 `OutTradeNo`。两个都认，🔴 但**不猜别的名字**——读不到就回 null，
    //   调用方按"读不出"应答失败（宁可让平台重推，也不拿一条认不出的报文去改状态）。
    outTradeNo: flat.OutTradeNo || flat.MchOrderId || null,
    openid: flat.OpenId || flat.FromUserName || null, // 通则：FromUserName 就是这条消息来自的那个用户 openid
    wxOrderId: flat.WxOrderId || null,
    refundId: flat.WxRefundId || null,
    mchRefundId: flat.MchRefundId || null,
    refundFee: flat.RefundFee === undefined ? null : flat.RefundFee,
    retCode: flat.RetCode === undefined ? null : flat.RetCode,
    env: flat.Env === undefined ? null : flat.Env,
    mchOrderNo: flat['WeChatPayInfo.MchOrderNo'] || null,
    productId: flat['GoodsInfo.ProductId'] || null,
    quantity: flat['GoodsInfo.Quantity'] || null,
    msgType: flat.MsgType || null,
    toUserName: flat.ToUserName || null,
  }
}

/**
 * 应答体。🔴 `ok:false` 回的是**非 0** 的 ErrCode——这一格是 4.5 三态表的实现："尚不可判定"
 * 必须让平台继续重推（上限 15 次），回 `ErrCode 0` 等于亲手关掉四层兜底的第①层。
 * ⚠️ 通用推送页那句"回空串或 `success`"是**普通消息**的口径；虚拟支付那一页给的是这张 XML，
 *   所以按虚拟支付页写（两者不冲突：这里的 `ErrMsg` 就是 `success`）。
 */
export function pushReplyXml({ ok, errmsg }) {
  const code = ok ? 0 : 1
  const msg = String(errmsg || (ok ? 'success' : 'retry'))
  return `<xml><ErrCode>${code}</ErrCode><ErrMsg><![CDATA[${msg}]]></ErrMsg></xml>`
}

/** 排障用的原文截断：只进日志，🔴 不进库、不进响应体 */
export function excerpt(text, max = 600) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : s.slice(0, max) + `…‹共 ${s.length} 字›`
}
