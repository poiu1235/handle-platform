// 下单侧的签名与一次性凭证换取（PRD v3 6.3／6.2 铁律 3／U-7 已判＝ⓐ）。
//
// 🔴 U-7 ⓐ 这条红线是本文件的**存在理由**：`session_key` 只在 CF 内存里活几毫秒，
//   签完即弃——不落库、不透传给端上、不进日志、不进错误对象。工程稿那套建 `wechat_sessions`
//   表长期托管 session_key 的写法（ⓑ）已被 owner 明确不采，所以这里**不许**出现任何缓存结构。
//   连带两条纪律（正本 6.3）：① 换取失败或签名报错 ⇒ 只走"重取 code 再换一次"这一条兜底，
//   不许退化成缓存；② 不许顺手用 session_key 解密任何开放数据（本项目只取 openid／unionid）。
//
// 🔴 签名要**贴着拉起支付那一刻才算**：从"签好"到"用户点确认"之间若发生了一次静默重新登录
//   （冷启动、ensureAuth 刷新、切前台），session_key 可能已换 ⇒ 校验报错。签完即弃正好把窗口压到最短。
//
// ⚠️ 逐字节一致是硬要求：`paySig` 与 `signature` 签的都是**同一个 post_body 字符串**，
//   而端上必须把同一个字符串原样交给 `wx.requestVirtualPayment`。⇒ 本模块返回的是**字符串**
//   （不是对象），端上也不许 JSON.parse 之后再 stringify（键序与空格一变，签名就废——
//   而且失败症状长得像"平台拒绝"）。

const PAY_URI = 'requestVirtualPayment' // C 端 uri 固定值（6.3 实证）

async function hmacSha256Hex(keyStr, message) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 我方单号：官方要求 8–32 位、**不能以下划线开头**、不可复用（6.3／R-9 ⑩）。
 * `'T' + 13 位毫秒 + 8 位随机 hex` ＝ 22 位，首字符是字母 ⇒ 三条都满足；随机段防并发同毫秒撞 unique。
 */
export function makeOutTradeNo(rand = () => Math.floor(Math.random() * 0xffffffff)) {
  return 'T' + Date.now().toString() + rand().toString(16).padStart(8, '0').slice(-8)
}

/**
 * 组装 signData 并签两个名。**键序在这里固定**（一次定义、两端共用），因为 post_body 字符串
 * 本身就是签名输入——任何一端单独重排键序都会让签名失效。
 * `goodsPrice` 单位＝分，且必须取服务端价格表（6.2 铁律 3：客户端传的金额一律不用、只用于比对）。
 */
export async function buildPayPayload({ env, sessionKey, product, outTradeNo, attach }) {
  const offerId = env.WX_PAY_OFFER_ID
  const appKey = env.WX_PAY_APPKEY_PROD
  if (!offerId) throw new Error('pro_pay_config_missing:WX_PAY_OFFER_ID')
  if (!appKey) throw new Error('pro_pay_config_missing:WX_PAY_APPKEY_PROD')
  if (typeof sessionKey !== 'string' || sessionKey === '') throw new Error('pro_pay_no_session_key')
  if (!product || !Number.isInteger(product.goodsPrice) || product.goodsPrice <= 0) throw new Error('pro_pay_bad_product')

  const signData = {
    offerId: String(offerId),
    buyQuantity: 1, // V1 恒 1（3.1）；它同时是签名组成部分 ⇒ 留痕在订单行 buy_quantity
    env: 0, // 官方个人版页「固定填 0」（D-10：V1 不依赖沙箱）
    currencyType: 'CNY',
    productId: String(product.productId),
    goodsPrice: product.goodsPrice,
    outTradeNo: String(outTradeNo),
    attach: String(attach || ''),
  }
  const postBody = JSON.stringify(signData)
  return {
    signData,
    postBody,
    paySig: await hmacSha256Hex(appKey, `${PAY_URI}&${postBody}`),
    signature: await hmacSha256Hex(sessionKey, postBody),
  }
}

/**
 * 用一次性 `wx.login` code 换 `session_key`（**只给签名用**）。
 * 🔴 与 `_lib/wxTicket.js` 的 `code2session` 分开：那个函数刻意**不返回** session_key（PRD 3.3.5-3），
 *   三个既有调用点都只需要 openid——改它就是把 session_key 送到五个调用点手上。
 *   所以这里新写一条只服务支付路径的通道，返回的 sessionKey 由调用方**就地用完即弃**。
 * 顺带回 openid ⇒ 下单前置②（"当场换取的 openid ＝ 本账号当前绑定的 openid"）一次调用就够，
 *   不必为同一个 code 再发第二次请求（一个 code 只能用一次）。
 */
export async function code2sessionKey(code, env) {
  if (!code) return { ok: false, errcode: 'no_code', errmsg: '缺少 wx.login code' }
  if (!env.WX_APPID || !env.WX_SECRET) return { ok: false, errcode: 'config_missing', errmsg: 'WX_APPID/WX_SECRET 未配置' }
  const url =
    `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(env.WX_APPID)}` +
    `&secret=${encodeURIComponent(env.WX_SECRET)}` +
    `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  } catch {
    return { ok: false, errcode: 'unreachable', errmsg: '' }
  }
  const data = await res.json().catch(() => null)
  if (!data || data.errcode || !data.openid || !data.session_key) {
    // 🔴 日志里只打 errcode／errmsg 与 openid 是否存在——**session_key 一个字符都不许出现**，
    //   连"打一半"都不行（workerd 会把异常换成 internal error，所以真因只能在这里留痕）。
    console.error('[proPaySign] code2session failed:', JSON.stringify({ errcode: data?.errcode ?? 'unparseable', errmsg: data?.errmsg || '' }))
    return { ok: false, errcode: data?.errcode ?? 'unparseable', errmsg: data?.errmsg || '' }
  }
  return { ok: true, openid: data.openid, unionid: data.unionid || null, sessionKey: data.session_key }
}

/** 只回端上**需要**的三样：拉起参数 + 我方单号。🔴 sessionKey 与 openid 都不在这里出现 */
export function toClientPayParams(payload) {
  return {
    mode: 'short_series_goods', // 官方个人版页固定值（6.3）
    signData: payload.signData,
    paySig: payload.paySig,
    signature: payload.signature,
  }
}
