import { json, translateSupabaseError } from '../_lib/supabase.js'

export async function onRequestPost(context) {
  const { request, env } = context
  const { refreshToken } = await request.json().catch(() => ({}))
  if (!refreshToken) return json({ error: '缺少 refreshToken' }, 400)

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return json({ error: translateSupabaseError(data) }, res.status)

  return json({ accessToken: data.access_token, refreshToken: data.refresh_token })
}