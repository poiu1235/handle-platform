import { json } from '../_lib/supabase.js'
import { verifyUserBearer, serviceRoleFetch } from '../_lib/userAuth.js'

// D5 7.5：绑定管理列表。只回 provider + bound_at，不回 openid——openid 是半公开
// 标识（3.3.5-1），列给客户端 UI 没有任何需要它的场景，徒增泄露面。
// 访客账号天然返回空列表（其 identity 归属由免登路径管理，绑定管理页只对邮箱
// 账号有意义；不做特判，数据本来就是这个形状）。
export async function onRequestGet(context) {
  const { request, env } = context
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: '服务端未配置 SUPABASE_SERVICE_ROLE_KEY' }, 500)

  const user = await verifyUserBearer(request, env)
  if (!user) return json({ error: '登录状态无效或已过期，请重新登录' }, 401)

  const rows = await serviceRoleFetch(
    env,
    `/rest/v1/user_identities?select=provider,bound_at&user_id=eq.${encodeURIComponent(user.userId)}&order=bound_at.asc`,
  )
  if (!rows.ok) {
    console.error('[identities] query failed:', JSON.stringify(rows.data))
    return json({ error: '服务端异常，请稍后再试' }, 500)
  }
  return json({ identities: rows.data ?? [] })
}
