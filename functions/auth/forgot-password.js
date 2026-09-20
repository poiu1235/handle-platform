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
  // B9：访客占位域不可找回——否则 GoTrue 会对不可投递域发信（必然退信），
  // 且找回密码对访客本来就不是恢复通道（无密码体系）
  if (isGuestEmail(email)) {
    return json({ error: '这是微信访客账号，请在微信内直接打开使用或绑定邮箱', code: 'guest_account' }, 400)
  }

  const { ok, status, data } = await supabaseAuthFetch(env, '/recover', {
    email,
    gotrue_meta_security: captchaToken ? { captcha_token: captchaToken } : undefined,
  })

  if (!ok) return json({ error: translateSupabaseError(data) }, status)
  return json({ ok: true })
}