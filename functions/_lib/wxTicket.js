// 微信小程序身份验真（PRD D3/D4）：code2session 及其布尔封装。
// WX_APPID / WX_SECRET 存放在 CF Secret；secret 缺失时一律 fail-closed——
// 认证通道的失败模式只能是「拒绝」，绝不因配置缺失放行。
import { json } from './supabase.js'

const JSCODE2SESSION_URL = 'https://api.weixin.qq.com/sns/jscode2session'

// 与 turnstile 三态同一套分格理由：「连不上微信 / 服务端没配 key」和「这个 code
// 无效」压成同一句「微信身份校验失败（errcode: X）」，会把服务端故障说成用户的错。
// 判定信息只能由发起方给——异常会被 workerd 换成 internal error，catch 里读不到
// 真因（详见 functions/_middleware.js 注释）。
export const WX_UNREACHABLE = 'unreachable'

// 这三个 errcode 都是服务端问题，与请求方无关
const SERVER_SIDE_ERRCODES = new Set([WX_UNREACHABLE, 'config_missing', 'unparseable'])

// 三个调用点（authGate / wechat-login / wechat-bind）共用，避免文案在三处各写一遍
// 然后各自漂移：服务端故障 → 503 wx_ticket_unavailable；真 errcode → 400 原样透出。
export function wxTicketResponse(wx) {
  if (!wx.ok && SERVER_SIDE_ERRCODES.has(wx.errcode)) {
    return json({ error: '微信身份校验服务暂时不可用，请稍后再试', code: 'wx_ticket_unavailable' }, 503)
  }
  return json({ error: `微信身份校验失败（errcode: ${wx.errcode}）`, code: 'wx_ticket_invalid' }, 400)
}

// 一次性 wx.login code（约 5 分钟时效、用一次即失效，只能由真实微信客户端取得）
// 换取 openid / unionid。
// 返回 { ok: true, openid, unionid } 或 { ok: false, errcode, errmsg }——
// errcode/errmsg 原样透出用于排障（40013=appid 不符 / 40125=secret 错 /
// 40029=code 无效或已被用 / 40164=IP 不在白名单），调用方决定给客户端看多少。
// session_key 只在此处出现，不落库、不透传、不进日志（PRD 3.3.5-3）。
export async function code2session(code, env) {
  if (!code) return { ok: false, errcode: 'no_code', errmsg: '缺少 wx.login code' }
  if (!env.WX_APPID || !env.WX_SECRET) {
    return { ok: false, errcode: 'config_missing', errmsg: 'WX_APPID/WX_SECRET 未配置' }
  }
  const url =
    `${JSCODE2SESSION_URL}?appid=${encodeURIComponent(env.WX_APPID)}` +
    `&secret=${encodeURIComponent(env.WX_SECRET)}` +
    `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  } catch {
    return { ok: false, errcode: WX_UNREACHABLE, errmsg: '' }
  }
  const data = await res.json().catch(() => null)
  if (!data || data.errcode || !data.openid) {
    console.error('[wxTicket] code2session failed:', JSON.stringify(data))
    return { ok: false, errcode: data?.errcode ?? 'unparseable', errmsg: data?.errmsg || '' }
  }
  return { ok: true, openid: data.openid, unionid: data.unionid || null }
}

// mp 通道验真（D4 authGate 用）：能换到 openid 即视为「真实微信会话」。
// 注意它证明了「请求来自真实微信客户端会话」而非「真人操作」——群控/自动化设备
// 仍可能批量绕过（R15），兜底靠邮箱验证码与 authGate 的频控。
export async function verifyWxTicket(code, env) {
  const r = await code2session(code, env)
  return r.ok
}
