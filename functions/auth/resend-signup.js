import { json, supabaseAuthFetch, translateSupabaseError } from '../_lib/supabase.js'
import { authGate } from '../_lib/authGate.js'
import { isGuestEmail } from '../_lib/guestUser.js'

export async function onRequestPost(context) {
  const { request, env } = context
  // 认证闸门（D4）：mp 通道验 wxLoginCode、Web 通道验 Turnstile，未过闸不触达 Supabase
  const gate = await authGate(request, env)
  if (!gate.pass) return gate.response
  const { email, captchaToken } = await request.json().catch(() => ({}))
  if (!email) return json({ error: '缺少邮箱' }, 400)
  // B9：访客占位域不进重发（防对不可投递域的邮件轰炸面）
  if (isGuestEmail(email)) {
    return json({ error: '该邮箱地址不可用', code: 'guest_account' }, 400)
  }

  const { ok, status, data } = await supabaseAuthFetch(env, '/resend', {
    type: 'signup',
    email,
    gotrue_meta_security: captchaToken ? { captcha_token: captchaToken } : undefined,
  })

  if (!ok) return json({ error: translateSupabaseError(data) }, status)
  return json({ ok: true })
}