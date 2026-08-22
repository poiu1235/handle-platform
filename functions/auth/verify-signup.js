import { json, supabaseAuthFetch, translateSupabaseError } from '../_lib/supabase.js'

export async function onRequestPost(context) {
  const { request, env } = context
  const { email, code } = await request.json().catch(() => ({}))
  if (!email || !code) return json({ error: '缺少邮箱或验证码' }, 400)

  const { ok, status, data } = await supabaseAuthFetch(env, '/verify', {
    email,
    token: code,
    type: 'signup',
  })

  if (!ok || !data.access_token) {
    return json({ error: translateSupabaseError(data) }, status || 400)
  }

  // 注册验证码通过 = 正常登录态（amr 不是 recovery），可以放心把 token 下发给前端，
  // /api/* 的 _middleware.js 会正常放行
  return json({ accessToken: data.access_token, refreshToken: data.refresh_token })
}