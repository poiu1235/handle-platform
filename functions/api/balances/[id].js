import { json } from '../../_lib/supabase.js'

function restHeaders(env, accessToken) {
  return {
    'Content-Type': 'application/json',
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken}`,
  }
}

export async function onRequestPatch(context) {
  const { env, data, request, params } = context
  const payload = await request.json().catch(() => ({}))

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/balances?id=eq.${params.id}`, {
    method: 'PATCH',
    headers: { ...restHeaders(env, data.accessToken), Prefer: 'return=representation' },
    body: JSON.stringify(payload), // { app_name?, amount?, updated_at }
  })
  const body = await res.json().catch(() => ({}))
  return json(body, res.status)
}

export async function onRequestDelete(context) {
  const { env, data, params } = context
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/balances?id=eq.${params.id}`, {
    method: 'DELETE',
    headers: restHeaders(env, data.accessToken),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    return json(body, res.status)
  }
  return json({ ok: true })
}