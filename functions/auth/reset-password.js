import { json } from '../_lib/supabase.js'
import { verifyResetTicket } from '../_lib/resetTicket.js'
import { isPasswordValid, passwordHint } from '../../shared/passwordRules.js'

// 密码复杂度规则从前后端共用的 shared/passwordRules.js 引入——这道服务端校验本身
// 就是防线之一，不是"前端已经拦过就不用管"的形式主义

export async function onRequestPost(context) {
  const { request, env } = context
  const { resetTicket, password } = await request.json().catch(() => ({}))
  if (!resetTicket || !password) return json({ error: '缺少参数' }, 400)

  let payload
  try {
    payload = await verifyResetTicket(env, resetTicket)
  } catch {
    return json({ error: '重置链接已失效，请重新申请验证码' }, 401)
  }

  if (!isPasswordValid(password)) {
    return json({ error: passwordHint() }, 400)
  }

  // 用 service_role 通过 Admin API 直接改密码——全程没有在浏览器里出现过
  // 任何可被复用的 Supabase access_token，这一步和"登录态"彻底解耦
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${payload.sub}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ password }),
  })

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    return json({ error: data?.msg || '密码更新失败，请重试' }, res.status)
  }

  return json({ ok: true })
}