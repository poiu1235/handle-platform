import { json } from '../../_lib/supabase.js'
// restHeaders 是全部业务端点共用的底层转发头（现寄居 cards/_lib.js，复用不拷贝）
import { restHeaders } from '../cards/_lib.js'
import { FINISHED_CLOCK_SKEW_MS } from '../../../shared/notesConfig.js'
import {
  contentError,
  deriveState,
  dueDateError,
  isISODate,
  todayISO,
} from '../../../shared/notesDomain.js'

// 便利贴单条端点（PRD 8.3）。
//
// PATCH 白名单 = content / due_date / pinned / finished_at——kind 不在白名单
// （D15 类型不可互转；notes_kind_lock 触发器兜底直写）。
// PATCH 规则按派生态收紧（客户端携带 today 供判定）：
//   正常态 → 全部可改；已过期 → 仅 finished_at（转为已完成）；已完成 → 拒绝
//   一切 PATCH（只可删除，9.1-10；notes_finish_lock 触发器兜底）。
// DELETE：任意状态可用（removed 0|1 语义与 cards 对称）。

// ── PATCH：编辑（正常态）/ 钉住（正常态）/ 完成（正常 + 过期态）──
export async function onRequestPatch(context) {
  const { env, data, request, params } = context
  const payload = await request.json().catch(() => ({}))
  const today = isISODate(payload.today) ? payload.today : todayISO()

  // 现行行 = 派生态判定基准；取不到 = 不存在 / 不属于该用户 → 404
  const cur = await fetch(
    `${env.SUPABASE_URL}/rest/v1/notes?select=*&id=eq.${params.id}`,
    { headers: restHeaders(env, data.accessToken) },
  )
  const curBody = await cur.json().catch(() => [])
  if (!Array.isArray(curBody) || curBody.length === 0) {
    return json({ error: '条目不存在或无权访问' }, 404)
  }
  const row0 = curBody[0]
  const state0 = deriveState(row0, today)

  // —— 字段白名单 + 基础校验 ——
  const row = {}
  if (payload.content !== undefined) {
    const err = contentError(payload.content)
    if (err) return json({ error: err }, 400)
    row.content = payload.content.trim()
  }
  if (payload.due_date !== undefined) {
    const due = payload.due_date ? payload.due_date : null
    // 灵感不可带日期（D3）；窗口 [today, today+7]（清空 = 显式 null，diff-only 契约）
    const err = dueDateError(due, row0.kind, today)
    if (err) return json({ error: err }, 400)
    row.due_date = due
  }
  if (payload.pinned !== undefined) {
    if (typeof payload.pinned !== 'boolean') return json({ error: 'pinned 需为布尔值' }, 400)
    row.pinned = payload.pinned
  }
  if (payload.finished_at !== undefined) {
    // 显式 null = 恢复已完成——产品不提供（9.1-10），CF 层给出可读拒绝
    if (payload.finished_at === null) return json({ error: '已完成不可恢复' }, 400)
    const t = Date.parse(payload.finished_at)
    if (!Number.isFinite(t)) return json({ error: '完成时刻无效' }, 400)
    if (t > Date.now() + FINISHED_CLOCK_SKEW_MS) {
      return json({ error: '完成时刻不能晚于当前时间' }, 400)
    }
    row.finished_at = payload.finished_at
  }
  if (Object.keys(row).length === 0) return json({ error: '没有可更新的字段' }, 400)

  // —— 派生态收紧：以库内现值 + 客户端本地「今天」判定 ——
  if (state0 === 'done-manual' || state0 === 'done-auto') {
    return json({ error: '已完成条目只可删除' }, 400)
  }
  if (state0 === 'expired' && Object.keys(row).some((k) => k !== 'finished_at')) {
    return json({ error: '已过期条目仅可转为已完成或删除（不可编辑 / 改期复活）' }, 400)
  }

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/notes?id=eq.${params.id}`, {
    method: 'PATCH',
    headers: restHeaders(env, data.accessToken, { Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return json(body, res.status)
  if (!Array.isArray(body) || body.length === 0) {
    return json({ error: '条目不存在或无权访问' }, 404)
  }
  return json(body, 200)
}

// ── DELETE：删除（任意状态可用）──
export async function onRequestDelete(context) {
  const { env, data, params } = context
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/notes?id=eq.${params.id}`, {
    method: 'DELETE',
    headers: restHeaders(env, data.accessToken, { Prefer: 'return=representation' }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    return json(body, res.status)
  }
  const body = await res.json().catch(() => [])
  return json({ ok: true, removed: Array.isArray(body) ? body.length : 0 })
}
