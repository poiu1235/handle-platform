import { json } from '../../_lib/supabase.js'
import { buildBalanceInsert } from '../../_lib/balanceFields.js'
import { enforceBatchCapacity } from '../../_lib/proCap.js'

// 对应 BalanceImport.jsx 的批量粘贴导入：同名覆盖、不同名插入，一次提交多条，
// 语义和 balances.js 的单条 POST 一致，只是走数组批量 upsert
export async function onRequestPost(context) {
  const { env, data, request } = context
  const { rows } = await request.json().catch(() => ({}))

  if (!Array.isArray(rows) || rows.length === 0) {
    return json({ error: '没有可提交的数据' }, 400)
  }

  // 逐行走**同一份**校验（BQ16 拍「三条写路径共用一个模块」⇒ 批量粘贴不是漏网的入口）。
  // 任一行非法 ⇒ 整批 400 并报第几行。⚠ 这不是新增的严格性：数组 upsert 本就是一条语句，
  // 旧版第 7 行脏时同样整批回滚，只是把 PostgREST 那句不可读的 `{code,message}` 原样透传给用户
  // （2.6 的错体形状）。换成带行号的中文，是把**已经在发生的失败**说清楚，不改成败的边界。
  const payload = []
  for (let i = 0; i < rows.length; i++) {
    const { row, error } = buildBalanceInsert(rows[i], data.user.id)
    if (error) return json({ error: `第 ${i + 1} 行：${error}` }, 400)
    payload.push(row)
  }

  // 容量墙（3.4 点名的"最容易漏的那个入口"）。整批预检：超出 ⇒ 整批不导、告知还能导入几条。
  // 关态＝没有墙（现网 balances 导入从来没有行数限制）⇒ 不传 legacyCap。
  const gate = await enforceBatchCapacity({
    env,
    accessToken: data.accessToken,
    user: data.user,
    domain: 'balances',
    table: 'balances',
    keyColumn: 'app_name',
    keys: payload.map((r) => r.app_name),
  })
  if (!gate.allowed) return json({ error: gate.error }, 409)

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