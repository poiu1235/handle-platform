import { json, supabaseAuthFetch, translateSupabaseError } from '../_lib/supabase.js'

export async function onRequestPost(context) {
  const { request, env } = context
  const { email, captchaToken } = await request.json().catch(() => ({}))
  if (!email) return json({ error: '缺少邮箱' }, 400)

  const { ok, status, data } = await supabaseAuthFetch(env, '/resend', {
    type: 'signup',
    email,
    gotrue_meta_security: captchaToken ? { captcha_token: captchaToken } : undefined,
  })

  if (!ok) return json({ error: translateSupabaseError(data) }, status)
  return json({ ok: true })
}