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

  // 管理员接口（下面真正用来改密码的那个）不会像 Supabase 自助改密码接口那样
  // 校验"新密码不能和旧密码相同"——这里手动补一道：拿新密码去尝试正常登录，
  // 如果用这个"新"密码就能登进去，说明它其实就是当前密码，直接拒绝；登录失败
  // （凭证不对）才说明确实是不同的密码，继续往下改。
  // 只有明确拿到 access_token（登录成功）才判定为"密码相同"；任何其他失败原因
  // （比如项目开了验证码保护导致这次尝试本身就过不去）都不能当成"密码不同"的
  // 证据——宁可不做这道校验，也不能误伤正常的改密码请求
  const sameCheck = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY },
    body: JSON.stringify({ email: payload.email, password }),
  })
  const sameCheckData = await sameCheck.json().catch(() => ({}))

  if (sameCheck.ok && sameCheckData.access_token) {
    // 立即吊销这次为了做校验而产生的、货真价实的登录 session，不能留着复用
    await fetch(`${env.SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${sameCheckData.access_token}`,
      },
    }).catch(() => {})

    return json({ error: '新密码不能与当前密码相同，请换一个' }, 400)
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