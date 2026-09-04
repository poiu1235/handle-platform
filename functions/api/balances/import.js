import { json } from '../../_lib/supabase.js'

// 对应 BalanceImport.jsx 的批量粘贴导入：同名覆盖、不同名插入，一次提交多条，
// 语义和 balances.js 的单条 POST 一致，只是走数组批量 upsert
export async function onRequestPost(context) {
  const { env, data, request } = context
  const { rows } = await request.json().catch(() => ({}))

  if (!Array.isArray(rows) || rows.length === 0) {
    return json({ error: '没有可提交的数据' }, 400)
  }

  const payload = rows.map((r) => ({
    app_name: r.app_name,
    amount: r.amount,
    updated_at: r.updated_at,
    icon_key: r.icon_key || null,
    user_id: data.user.id,
  }))

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/balances?on_conflict=user_id,app_name`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${data.accessToken}`,
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(payload),
  })
  const body = await res.json().catch(() => ({}))
  return json(body, res.status)
}