import { json, supabaseAuthFetch, translateSupabaseError } from '../_lib/supabase.js'
import { issueResetTicket } from '../_lib/resetTicket.js'

export async function onRequestPost(context) {
  const { request, env } = context
  const { email, code } = await request.json().catch(() => ({}))
  if (!email || !code) return json({ error: '缺少邮箱或验证码' }, 400)

  // 用 anon key 向 Supabase 校验验证码本身是否正确。这一步 Supabase 会正常返回一个
  // "恢复态" session（access_token 的 amr 最后一项是 recovery）——但我们刻意不把它
  // 转发给浏览器，只用它在服务端确认"这个人确实拿到了这封邮件里的验证码"，
  // 随后立刻换成我们自己签发的、结构上完全不同的一次性重置票据（见 resetTicket.js）。
  const { ok, status, data } = await supabaseAuthFetch(env, '/verify', {
    email,
    token: code,
    type: 'recovery',
  })

  if (!ok || !data.access_token) {
    return json({ error: translateSupabaseError(data) }, status || 400)
  }

  const ticket = await issueResetTicket(env, {
    userId: data.user.id,
    email: data.user.email,
  })

  // 立即吊销这个从未下发给浏览器、但已经在这次请求里短暂存在过的 recovery session，
  // 避免它的 refresh_token 以任何方式被后续复用——它此后唯一的作用就是刚才那次换票
  await fetch(`${env.SUPABASE_URL}/auth/v1/logout`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${data.access_token}`,
    },
  }).catch(() => {})

  return json({ resetTicket: ticket })
}