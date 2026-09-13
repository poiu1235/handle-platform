import { json } from '../_lib/supabase.js'
import { code2session } from '../_lib/wxTicket.js'
import { serviceRoleFetch } from '../_lib/userAuth.js'

// openid 免登（PRD D3 3.3.4）：冷启动 wx.login code → openid → 查映射。
// 门禁就是 code 本身——一次性、约 5 分钟时效、只能在小程序客户端内取得（3.3.5-2）。
//
// 命中映射：服务端用 service_role 走 generate_link + verify 替用户完成一次
// magic link 登录，下发真实 Supabase 会话（全程不出网到邮箱）。
// R7 spike 结论（2026-09-13，scripts/spike-gotrue-session.mjs）：
//   verify 的请求形态必须是 { type: 'magiclink', token_hash }——
//   旧形态 { type, token } 在当前 Supabase 版本会被 400 拒绝。
// 未命中：返回 { bound: false }，客户端走邮箱登录，登录成功后回到 wechat-bind 流程。
export async function onRequestPost(context) {
  const { request, env } = context
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: '服务端未配置 SUPABASE_SERVICE_ROLE_KEY' }, 500)

  const { code } = await request.json().catch(() => ({}))
  const wx = await code2session(code, env)
  if (!wx.ok) {
    return json({ error: `微信身份校验失败（errcode: ${wx.errcode}）`, code: 'wx_ticket_invalid' }, 400)
  }

  const found = await serviceRoleFetch(
    env,
    `/rest/v1/user_identities?select=user_id&provider=eq.wechat_mp&openid=eq.${encodeURIComponent(wx.openid)}`,
  )
  const userId = found.data?.[0]?.user_id
  if (!userId) return json({ bound: false })

  // generate_link 按 email 生成一次性凭证 → 映射表只有 user_id，先查邮箱
  const u = await serviceRoleFetch(env, `/auth/v1/admin/users/${encodeURIComponent(userId)}`)
  const email = u.data?.email
  if (!u.ok || !email) {
    console.error('[wechat-login] admin user lookup failed:', JSON.stringify(u.data))
    return json({ error: '免登失败，请用邮箱登录' }, 500)
  }

  const gl = await serviceRoleFetch(env, '/auth/v1/admin/generate_link', {
    method: 'POST',
    body: { type: 'magiclink', email },
  })
  const tokenHash = gl.data?.properties?.token_hash ?? gl.data?.hashed_token
  if (!gl.ok || !tokenHash) {
    console.error('[wechat-login] generate_link failed:', JSON.stringify(gl.data))
    return json({ error: '免登失败，请用邮箱登录' }, 500)
  }

  // R7 结论：token_hash 走 token_hash 字段；以 anon apikey 模拟公开客户端完成 verify
  const vf = await fetch(`${env.SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY },
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
  })
  const session = await vf.json().catch(() => ({}))
  if (!vf.ok || !session.access_token || !session.refresh_token) {
    console.error('[wechat-login] verify failed:', JSON.stringify(session).slice(0, 300))
    return json({ error: '免登失败，请用邮箱登录' }, 500)
  }

  // 响应形状与 /auth/login 一致（accessToken/refreshToken），客户端 applySession 直接消费
  return json({ accessToken: session.access_token, refreshToken: session.refresh_token })
}
