import { json, supabaseAuthFetch, translateSupabaseError } from '../_lib/supabase.js'
import { isPasswordValid, passwordHint } from '../../shared/passwordRules.js'

export async function onRequestPost(context) {
  const { request, env } = context
  const { email, password, captchaToken } = await request.json().catch(() => ({}))
  if (!email || !password) return json({ error: '缺少邮箱或密码' }, 400)

  // 服务端自己做一遍校验，不依赖前端、也不单独依赖 Supabase Dashboard 的密码策略——
  // 这道检查本身就是防线，顺带省一次注定会失败的 Supabase 请求
  if (!isPasswordValid(password)) {
    return json({ error: passwordHint() }, 400)
  }

  const { ok, status, data } = await supabaseAuthFetch(env, '/signup', {
    email,
    password,
    gotrue_meta_security: captchaToken ? { captcha_token: captchaToken } : undefined,
  })

  if (!ok) return json({ error: translateSupabaseError(data) }, status)

  // 注册接口本身不下发 accessToken/refreshToken 给前端——用户还没验证邮箱，
  // 只告知前端"验证码已发出"，真正的登录态从 verify-signup 才开始
  return json({ ok: true })
}