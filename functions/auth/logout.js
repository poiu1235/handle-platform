import { json } from '../_lib/supabase.js'

export async function onRequestPost(context) {
  const { request, env } = context
  const { refreshToken } = await request.json().catch(() => ({}))

  if (refreshToken) {
    try {
      // 用 refresh token 换一个可用于 revoke 的 access token 再登出；
      // 换不到也无所谓，前端本地反正会清掉自己存的 token
      const tokenRes = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY },
        body: JSON.stringify({ refresh_token: refreshToken }),
      })
      const tokenData = await tokenRes.json().catch(() => ({}))
      if (tokenData.access_token) {
        await fetch(`${env.SUPABASE_URL}/auth/v1/logout`, {
          method: 'POST',
          headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${tokenData.access_token}` },
        })
      }
    } catch {
      // 忽略，前端会清本地 token
    }
  }

  return json({ ok: true })
}