// 微信小程序身份验真（PRD D3/D4）：code2session 及其布尔封装。
// WX_APPID / WX_SECRET 存放在 CF Secret；secret 缺失时一律 fail-closed——
// 认证通道的失败模式只能是「拒绝」，绝不因配置缺失放行。
const JSCODE2SESSION_URL = 'https://api.weixin.qq.com/sns/jscode2session'

// 一次性 wx.login code（约 5 分钟时效、用一次即失效，只能由真实微信客户端取得）
// 换取 openid / unionid。
// 返回 { ok: true, openid, unionid } 或 { ok: false, errcode, errmsg }——
// errcode/errmsg 原样透出用于排障（40013=appid 不符 / 40125=secret 错 /
// 40029=code 无效或已被用 / 40164=IP 不在白名单），调用方决定给客户端看多少。
// session_key 只在此处出现，不落库、不透传、不进日志（PRD 3.3.5-3）。
export async function code2session(code, env) {
  if (!code || !env.WX_APPID || !env.WX_SECRET) {
    return { ok: false, errcode: 'config_missing', errmsg: 'WX_APPID/WX_SECRET 未配置' }
  }
  const url =
    `${JSCODE2SESSION_URL}?appid=${encodeURIComponent(env.WX_APPID)}` +
    `&secret=${encodeURIComponent(env.WX_SECRET)}` +
    `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`
  const res = await fetch(url)
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
