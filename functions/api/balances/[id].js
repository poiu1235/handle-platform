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

  // 改名唯一性预检（2026-09-02，对齐会员编辑改名）：修改弹窗改成已有其他记录的
  // 小程序名 → 400「已有同名小程序」（可读报错，防 PostgREST 直改撞唯一键返回
  // 不可读的 23505）。新增 POST 不预检——重名 = 覆盖那条记录，是明示语义
  if (payload.app_name !== undefined && typeof payload.app_name === 'string') {
    const newName = payload.app_name.trim()
    if (newName !== '') {
      const cur = await fetch(
        `${env.SUPABASE_URL}/rest/v1/balances?select=app_name&id=eq.${params.id}`,
        { headers: restHeaders(env, data.accessToken) }
      )
      const curBody = await cur.json().catch(() => [])
      const currentName = Array.isArray(curBody) && curBody.length > 0 ? curBody[0].app_name : null
      if (currentName !== null && newName !== currentName) {
        const dup = await fetch(
          `${env.SUPABASE_URL}/rest/v1/balances?select=id&user_id=eq.${data.user.id}&app_name=eq.${encodeURIComponent(newName)}`,
          { headers: restHeaders(env, data.accessToken) }
        )
        const dupBody = await dup.json().catch(() => [])
        if (Array.isArray(dupBody) && dupBody.length > 0) {
          return json({ error: '已有同名小程序，请换一个名字' }, 400)
        }
      }
    }
  }

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/balances?id=eq.${params.id}`, {
    method: 'PATCH',
    headers: { ...restHeaders(env, data.accessToken), Prefer: 'return=representation' },
    body: JSON.stringify(payload), // { app_name?, amount?, updated_at, icon_key? }（原样透传，icon_key 可传 null 清空）
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