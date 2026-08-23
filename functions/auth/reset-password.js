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
  // 校验"新密码不能和旧密码相同"——这里手动补一道。
  //
  // 第一版曾用"拿新密码去尝试正常登录"的办法做这个校验，但那条路本身要经过
  // /auth/v1/token?grant_type=password，撞上了登录页自己开的 Turnstile 人机验证——
  // 这里没带 captcha token，请求必然失败，导致校验形同虚设（不管密码是否相同，
  // 永远走"登录失败=密码不同"这条分支）。改成直接查库比对 bcrypt 哈希，完全不经过
  // Supabase Auth 的 /token 接口，就没有这个问题——对应的 SQL 函数见
  // supabase-check-current-password.sql，只有 service_role 能调用
  const sameCheckRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/check_current_password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ p_user_id: payload.sub, p_password: password }),
  })
  // 请求本身失败（比如 SQL 函数还没建）不能当成"密码不同"的证据——宁可不做这道
  // 校验，也不能误伤正常的改密码请求；只有明确拿到 true 才拒绝
  const isSamePassword = sameCheckRes.ok ? await sameCheckRes.json().catch(() => false) : false

  if (isSamePassword === true) {
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