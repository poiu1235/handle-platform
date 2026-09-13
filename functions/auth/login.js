import { json, translateSupabaseError } from '../_lib/supabase.js'
import { authGate } from '../_lib/authGate.js'

export async function onRequestPost(context) {
  const { request, env } = context
  // 认证闸门（D4）：mp 通道验 wxLoginCode、Web 通道验 Turnstile，未过闸不触达 Supabase
  const gate = await authGate(request, env)
  if (!gate.pass) return gate.response
  const { email, password, captchaToken } = await request.json().catch(() => ({}))
  if (!email || !password) return json({ error: '缺少邮箱或密码' }, 400)

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY },
    body: JSON.stringify({
      email,
      password,
      gotrue_meta_security: captchaToken ? { captcha_token: captchaToken } : undefined,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return json({ error: translateSupabaseError(data) }, res.status)

  return json({ accessToken: data.access_token, refreshToken: data.refresh_token })
}