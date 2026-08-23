import { json, supabaseAuthFetch, translateSupabaseError, isOtpInvalidOrExpired } from '../_lib/supabase.js'

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
    // Supabase 分不清"填错"和"过期"，这里把这一类含糊错误单独标出来，
    // 前端会按验证码发送时间自己猜一个更具体的提示（见 Register.jsx）
    return json(
      {
        error: translateSupabaseError(data),
        ...(isOtpInvalidOrExpired(data) ? { code: 'otp_invalid_or_expired' } : {}),
      },
      status || 400
    )
  }

  // 注册验证码通过 = 正常登录态（amr 不是 recovery），可以放心把 token 下发给前端，
  // /api/* 的 _middleware.js 会正常放行
  return json({ accessToken: data.access_token, refreshToken: data.refresh_token })
}