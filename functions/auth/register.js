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

  // 项目开了 Confirm email，这种配置下 Supabase 对"邮箱已注册且已确认"的情况
  // 不会走上面的错误分支——GoTrue 出于反邮箱枚举保护，会返回 200 和一个
  // identities 为空数组的伪造 user 对象，看起来跟正常注册成功一模一样。
  // 不识别这种情况的话，前端会以为验证码已发出，正常切到"输入验证码"页，
  // 但用户永远收不到邮件、也永远验证不过——必须在这里显式拦截
  if (Array.isArray(data.identities) && data.identities.length === 0) {
    return json({ error: '该邮箱已经注册过了，请直接登录', code: 'email_already_registered' }, 400)
  }

  // 注册接口本身不下发 accessToken/refreshToken 给前端——用户还没验证邮箱，
  // 只告知前端"验证码已发出"，真正的登录态从 verify-signup 才开始
  return json({ ok: true })
}