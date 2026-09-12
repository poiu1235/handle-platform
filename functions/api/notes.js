import { json } from '../_lib/supabase.js'
// restHeaders 是全部业务端点共用的底层转发头（anon key + 用户 Bearer + JSON），
// 现寄居 cards/_lib.js——便利贴复用之，避免第二份拷贝
import { restHeaders } from './cards/_lib.js'
import {
  DONE_RETENTION_DAYS,
  EXPIRED_RETENTION_DAYS,
  NO_DATE_TTL_DAYS,
  NOTES_CAP,
} from '../../shared/notesConfig.js'
import {
  addDaysISO,
  contentError,
  dueDateError,
  isISODate,
  todayISO,
} from '../../shared/notesDomain.js'

// 便利贴集合端点（PRD 8.3）。_middleware.js 已验签并把 access token 放进 data，
// 本层只做白名单 / 枚举 / 窗口校验（shared/notesDomain.js 与前端同源），RLS 兜底
// 数据归属。状态不在这里推导落库——过期 / 归档 / 清除全部由客户端按本地日历
// 派生（8.2），DB 触发器只兜不变式（notes_kind_lock / notes_finish_lock，
// 见 supabase/notes.sql 第 4 节）。

// ── GET：全量拉取（≤500 行；分区 / 排序 / 状态全在前端派生，切换零请求）──
export async function onRequestGet(context) {
  const { env, data } = context
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/notes?select=*&order=created_at.desc`, {
    headers: restHeaders(env, data.accessToken),
  })
  const body = await res.json().catch(() => null)
  if (body === null) return json({ error: '拉取失败' }, 502)
  return json(body, res.status)
}

// 物理行数（HEAD count；失败 → NaN，容量闸门放行——软护栏不挡关键路径）
async function countNotes(env, accessToken, userId) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/notes?select=id&user_id=eq.${userId}`,
    { method: 'HEAD', headers: restHeaders(env, accessToken, { Prefer: 'count=exact' }) },
  )
  const range = res.headers.get('content-range')
  return range ? Number(range.split('/')[1]) : NaN
}

// 服务端顺手清理（UTC 近似，PRD 8.5 服务端通道）：手动行 finished_at + 30 天、
// 自动有日期行 截止 + 38、无日期行 创建 + 45。RLS 把 DELETE 限定在本人行内；
// 失败由调用方忽略（最坏回到「读路径过滤、物理行暂存」的原状）
const DAY_MS = 86400000
async function sweepCleared(env, accessToken) {
  const nowMs = Date.now()
  const utcToday = new Date(nowMs).toISOString().slice(0, 10)
  // 逻辑树本体（不含 or= 前缀）——?or= 的值再带一层 "or=" 会被 PostgREST
  // 以 PGRST100 拒绝（e2e-notes-check 实测抓到的坑）
  const tree =
    `(finished_at.lt.${new Date(nowMs - DONE_RETENTION_DAYS * DAY_MS).toISOString()},` +
    `and(finished_at.is.null,due_date.lt.${addDaysISO(utcToday, -(EXPIRED_RETENTION_DAYS + 1 + DONE_RETENTION_DAYS))}),` +
    `and(finished_at.is.null,due_date.is.null,created_at.lt.${addDaysISO(utcToday, -(NO_DATE_TTL_DAYS + EXPIRED_RETENTION_DAYS + 1 + DONE_RETENTION_DAYS))}))`
  return fetch(`${env.SUPABASE_URL}/rest/v1/notes?or=${encodeURIComponent(tree)}`, {
    method: 'DELETE',
    headers: restHeaders(env, accessToken),
  }).catch(() => null)
}

// ── POST：新建（kind / content / due_date?；pinned 恒从 false 起——先上板再钉）──
export async function onRequestPost(context) {
  const { env, data, request } = context
  const payload = await request.json().catch(() => ({}))
  // 窗口校验「今天」口径（同 cards 预留 #8）：客户端本地日期优先，非法回退服务器
  // 日期；today 不在白名单内，不会进入转发载荷
  const today = isISODate(payload.today) ? payload.today : todayISO()

  if (payload.kind !== 'idea' && payload.kind !== 'memo') {
    return json({ error: '类型无效' }, 400)
  }
  const contentErr = contentError(payload.content)
  if (contentErr) return json({ error: contentErr }, 400)
  // 灵感带日期 / 格式非法 / 超出 [today, today+7] 窗口 → 400（D3/D5）
  const dueErr = dueDateError(payload.due_date, payload.kind, today)
  if (dueErr) return json({ error: dueErr }, 400)

  // 容量闸门（9.2-6）：达到上限时**先顺手清理再复数**（评审 2026-09-12 #1）——
  // 清理由客户端 GET 驱动，与按物理行数计数的容量校验节奏不同步，久未打开面板
  // 时「僵尸行」会占额度造成"没记几条却 409"；贴上限时用服务端 UTC 近似清一遍
  // 再复数。未达上限不做多余请求（僵尸行无害，读路径本就过滤，任一次 GET/POST
  // 都会顺带清走）
  let total = await countNotes(env, data.accessToken, data.user.id)
  if (Number.isFinite(total) && total >= NOTES_CAP) {
    await sweepCleared(env, data.accessToken)
    total = await countNotes(env, data.accessToken, data.user.id)
  }
  if (Number.isFinite(total) && total >= NOTES_CAP) {
    return json({ error: `便利贴已到上限（${NOTES_CAP} 条），先清理一些吧` }, 409)
  }

  const row = {
    user_id: data.user.id,
    kind: payload.kind,
    content: payload.content.trim(),
    pinned: false,
  }
  if (payload.due_date) row.due_date = payload.due_date

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/notes`, {
    method: 'POST',
    headers: restHeaders(env, data.accessToken, { Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  })
  const body = await res.json().catch(() => ({}))
  return json(body, res.status)
}

// ── DELETE /api/notes?id=in.(uuid,uuid)：清除扫描的批量物理删除（8.5）。
//    仅接受 id=in.(...) 形态（uuid 白名单正则），幂等——重复执行 0 行。
//    客户端在 GET 合入后派生已过清除时刻的行并触发本端点，多端任一端执行即可──
export async function onRequestDelete(context) {
  const { env, data, request } = context
  const idFilter = new URL(request.url).searchParams.get('id') || ''
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  if (!new RegExp(`^in\\.\\(${uuid}(,${uuid})*\\)$`, 'i').test(idFilter)) {
    return json({ error: '仅支持 id=in.(uuid,...) 批量删除' }, 400)
  }
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/notes?id=${encodeURIComponent(idFilter)}`, {
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
