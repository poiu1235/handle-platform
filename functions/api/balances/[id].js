import { json } from '../../_lib/supabase.js'
import { buildBalancePatch } from '../../_lib/balanceFields.js'

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

  // 校验 + 字段白名单的唯一正本在 ../../_lib/balanceFields.js（BQ3 拍 (α)、BQ15 拍 trim 进 CF）。
  // 部分更新语义不变：只带 payload 里出现过的键（端上"清零"就只发 amount + updated_at）。
  const { row, error } = buildBalancePatch(payload)
  if (error) return json({ error }, 400)

  // 改名唯一性预检（2026-09-02，对齐会员编辑改名）：修改弹窗改成已有其他记录的
  // 小程序名 → 400「已有同名小程序」（可读报错，防 PostgREST 直改撞唯一键返回不可读的 23505）。
  // 新增 POST 不预检——重名 = 覆盖那条记录，是明示语义。
  // ⚠ 这里比对的是**已 trim 的 row.app_name**，与下面写库用的是同一个值：旧版预检比 `trim()` 后的串、
  //   写库却透传原样 payload（`:19` vs `:43`），于是「预检通过的名字」与「落库的名字」可以差一串空格
  //   ⇒ 撞唯一键时仍然 23505、且库里留下一条带尾随空格的新行。本次并成同一个值。
  if (row.app_name !== undefined) {
    const newName = row.app_name
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

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/balances?id=eq.${params.id}`, {
    method: 'PATCH',
    headers: { ...restHeaders(env, data.accessToken), Prefer: 'return=representation' },
    body: JSON.stringify(row), // 白名单后的键：app_name?/amount?/updated_at?/icon_key?（icon_key 传 null = 清空）
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