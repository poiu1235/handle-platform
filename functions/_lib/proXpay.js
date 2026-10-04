// 服务端调 `/xpay/*` 的那一条通道（PRD v3 6.3／R-9 ①⑱）。
//
// ✅ 2026-10-04 从官方文档树 `dev/server/API/VirtualPayment/` 逐字读到的形状（正本附录甲已记）：
//   · 请求：`POST https://api.weixin.qq.com/xpay/query_order?access_token=…&pay_sig=…`
//   · 签名：`pay_sig = hex(hmac_sha256(appKey, uri + '&' + post_body))`，
//     且页面原话「uri，切记不可带参数，即去掉 "?" 及后面的部分」「对于 /xpay/query_user_balance 来说，
//     uri = /xpay/query_user_balance」⇒ **uri 是带前导斜杠的路径**，post_body 是**实际发出去的那个字符串**
//     （与端上 `requestVirtualPayment` 同一条公式，所以 HMAC 实现复用 `proPaySign.hmacSha256Hex`，不写第二份）。
//   · key 的选择：页面原话「env = 0 对应现网 AppKey，env = 1 对应沙箱 AppKey」⇒ V1 恒 env=0 ⇒ 恒现网那把。
//
// 🔴 这条通道**不碰 `session_key`**：`query_order` 的 query 里只有 `access_token` 与 `pay_sig`
//   （文档参数表里没有用户态签名那一列），所以 U-7 ⓐ 那条红线在这里不构成约束——
//   别"顺手"往这里加 session_key 相关的东西，那会把一条干净的服务器到服务器调用拖回一次性凭证的坑里。
//
// ⚠️ 四笔账（这是探测类代码，按纪律先算清）：
//   触发时机＝只有显式调用（探针路由／将来 B3-3 的入账事务），没有任何自动方；
//   单次成本＝两次对外 HTTP（一次取 access_token、一次打接口）；
//   频次上限＝探针手工跑；B3-3 里是"确认态每轮一次、进站一次"⇒ 一次购买最多 6×2 次调用；
//   平台自带 `268490015 频率限制`，而 `cgi-bin/token` 另有**每日获取上限**（微信通则，具体数值
//   未逐字复核）⇒ 真撞上限时的两条路是"缓存 token"或改走**稳定版 token 接口**，
//   别到时候先想到的是把用户的轮询缩短。
//   凭证＝`access_token` 用 WX_APPID/WX_SECRET 换（小程序全局凭证，**不消耗用户的一次性 code、
//   不动 session_key**）。⚠️ 这里**刻意不缓存** access_token：多 isolate 各持一份的凭证生命周期
//   正是正本 U-7 判 ⓐ 时否掉的那类缓存，V1 的量还不需要为它承担这个复杂度。
import { hmacSha256Hex } from './proPaySign.js'

const API_HOST = 'https://api.weixin.qq.com'
const TOKEN_URI = '/cgi-bin/token'

/**
 * 小程序服务端调用凭证（`grant_type=client_credential`）。
 * 返回 `{ ok:true, token }` 或 `{ ok:false, errcode, errmsg }`——🔴 失败原因原样透出，
 * 因为这一支最常见的两种失败（`40013 invalid appid`／`40125 invalid appsecret`／
 * `40164 IP 不在白名单`）与"接口没权限"是完全不同的处置，混成一句"取 token 失败"就没法定位。
 */
export async function getMiniAccessToken(env, fetchImpl = fetch) {
  if (!env.WX_APPID || !env.WX_SECRET) return { ok: false, errcode: 'config_missing', errmsg: 'WX_APPID/WX_SECRET 未配置' }
  const url =
    `${API_HOST}${TOKEN_URI}?grant_type=client_credential` +
    `&appid=${encodeURIComponent(env.WX_APPID)}&secret=${encodeURIComponent(env.WX_SECRET)}`
  let res
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) })
  } catch {
    return { ok: false, errcode: 'unreachable', errmsg: '' }
  }
  const data = await res.json().catch(() => null)
  if (!data || !data.access_token) {
    return { ok: false, errcode: data?.errcode ?? 'unparseable', errmsg: data?.errmsg || '' }
  }
  return { ok: true, token: data.access_token, expiresIn: Number(data.expires_in) || 0 }
}

/**
 * 服务端 `pay_sig`。🔴 入参 `uri` 必须是**不带 query 的路径**（含前导斜杠），
 * `postBody` 必须是**将要发出去的同一个字符串**——与端上那条铁律同源：签名输入是原始 body，
 * 任何一端重新序列化都会失效（症状是 `268490003 签名错误`，看起来像"平台抽风"）。
 */
export async function serverPaySig({ appKey, uri, postBody }) {
  if (!appKey) throw new Error('pro_pay_config_missing:WX_PAY_APPKEY_PROD')
  if (typeof uri !== 'string' || uri.indexOf('?') >= 0) throw new Error('pro_pay_sig_uri_must_have_no_query')
  if (typeof postBody !== 'string' || postBody === '') throw new Error('pro_pay_sig_no_post_body')
  return hmacSha256Hex(appKey, `${uri}&${postBody}`)
}

/**
 * 打一次 `/xpay/*` 服务端接口。**永远不抛**（探测代码的纪律：抛出去就只剩 503，看不到 errcode），
 * 一律回 `{ ok, status, errcode, errmsg, data, sent }`：
 *   · `sent` 是实际发出去的 post_body ⇒ 排障时要能看见"我们到底签了什么串"；
 *   · `errcode`／`errmsg` 原样透出 ⇒ R-9 ⑱ 的判据就靠它（`268490003`＝签名错，
 *     `48001`／"no authority"一类＝接口对我们这个主体不可用）。
 * 🔴 返回值里不带 access_token，也不许调用方把它打进日志。
 */
export async function xpayServerPost({ env, uri, body, accessToken, fetchImpl = fetch }) {
  const appKey = env.WX_PAY_APPKEY_PROD
  if (!appKey) return { ok: false, status: 0, errcode: 'config_missing', errmsg: 'WX_PAY_APPKEY_PROD 未配置', data: null, sent: null }
  if (!accessToken) return { ok: false, status: 0, errcode: 'no_access_token', errmsg: '缺少 access_token', data: null, sent: null }
  const postBody = JSON.stringify(body)
  let sig = null
  try {
    sig = await serverPaySig({ appKey, uri, postBody })
  } catch (err) {
    return { ok: false, status: 0, errcode: String((err && err.message) || 'sign_failed'), errmsg: '', data: null, sent: postBody }
  }
  const url = `${API_HOST}${uri}?access_token=${encodeURIComponent(accessToken)}&pay_sig=${encodeURIComponent(sig)}`
  let res = null
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: postBody,
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    return { ok: false, status: 0, errcode: 'unreachable', errmsg: '', data: null, sent: postBody }
  }
  const data = await res.json().catch(() => null)
  return {
    ok: res.ok && (!data || data.errcode === 0),
    status: res.status,
    errcode: data && data.errcode !== undefined ? data.errcode : 'unparseable',
    errmsg: (data && data.errmsg) || '',
    data,
    sent: postBody,
  }
}

/**
 * 把一次 `query_order` 的回包归到**六档**，供入账与前置④共用（同一份映射，别在两处各写一遍）。
 * 🔴 分档的依据是 2026-10-04 现网两跑 + 文档字段表（正本附录甲）：
 *   · `errcode:0` ⇒ 读 `order.status`：2/3/4 已付（待发货／发货中／已发货）、0/1 未付、6 已关闭、5/8 已退款；
 *   · `268490002` ⇒ **查无此单**。⚠️ 文档错误码表把这码写成"请求参数字段错误"，实测 errmsg 是
 *     "数据不存在" ⇒ **按 errmsg 与实测读，不按文档归类**（照文档写会把"平台没这单"当成"我们代码错了"）；
 *   · 其余非 0 的 errcode／HTTP 不 2xx／网络抛错 ⇒ `error`/`unreachable`，
 *     🔴 **绝不能归进 `unpaid`**——"未付"是有语义的结论（可以关单、可以应答失败），
 *     而"我这次没查到"不是。把后者当前者，就会在推送侧答"成功"替平台放弃 15 次重推。
 * @returns {'paid'|'unpaid'|'closed'|'refunded'|'not_found'|'error'|'unreachable'}
 */
export function classifyQueryResult(r) {
  if (!r || typeof r !== 'object') return 'error'
  if (r.errcode === 'unreachable') return 'unreachable'
  if (typeof r.errcode === 'string' && r.errcode.startsWith('token_')) return 'error' // 没打到接口
  if (r.errcode === 268490002) return 'not_found'
  if (r.errcode !== 0) return 'error'
  const order = r.data && r.data.order ? r.data.order : null
  if (!order) return 'not_found'
  const s = Number(order.status)
  if (s === 2 || s === 3 || s === 4) return 'paid'
  if (s === 0 || s === 1) return 'unpaid'
  if (s === 6) return 'closed'
  if (s === 5 || s === 8) return 'refunded'
  // 7 退款失败／9 回收广告金／10 分账回退，以及任何文档里还没见过的值 ⇒ 不猜
  return 'error'
}

/**
 * 查单（4.5 入账第 1 步"事实确认"的那一步）。
 * ⚠️ 文档里 `order_id` 与 `wx_order_id` 都标"否"，说明写的是"二选一"——**两个都不传的行为未证**，
 *   所以这里强制要求调用方至少给一个（探针传假单号是有意的：它要的是"查无此单"那一档的 errcode）。
 * 🔴 `env` 这里传的是**接口的 env**（0 现网／1 沙箱），与库里的 `env_type`（1 现网／2 沙箱）
 *   是两套枚举，别互相赋值——这是本轮读文档时最容易带进代码的一个坑（正本 4.2 已注明）。
 */
export async function xpayQueryOrder({ env, openid, orderId, wxOrderId, envFlag = 0, fetchImpl = fetch }) {
  if (!openid) return { ok: false, errcode: 'no_openid', errmsg: 'query_order 必须带 openid' }
  if (!orderId && !wxOrderId) return { ok: false, errcode: 'no_order_id', errmsg: 'order_id 与 wx_order_id 至少给一个' }
  const tok = await getMiniAccessToken(env, fetchImpl)
  if (!tok.ok) return { ok: false, errcode: `token_${tok.errcode}`, errmsg: tok.errmsg, data: null, sent: null }
  const body = { openid, env: envFlag }
  if (orderId) body.order_id = String(orderId)
  if (wxOrderId) body.wx_order_id = String(wxOrderId)
  return xpayServerPost({ env, uri: '/xpay/query_order', body, accessToken: tok.token, fetchImpl })
}
