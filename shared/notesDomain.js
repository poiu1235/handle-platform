// 便利贴（notes）纯函数模块——无任何请求；输入 = 全量行（snake_case）+ 今天
// （查看设备的本地日历 YYYY-MM-DD）。常量全部来自 shared/notesConfig.js，前端与
// Cloudflare 层 import 同一份，零口径分叉（形态对照 src/lib/cardsDomain.js）。
//
// 时间哲学（PRD 8.2）：状态全部由时间派生，不落库、无状态机——
//   截止日       = due_date ?? (created_at 本地日 + 7 天)
//   正常         = 今天 ≤ 截止日（截止日当天仍正常，标「今天到期」，D7）
//   已过期       = 截止日 < 今天 < 归档日（截止日 + 8）
//   已完成(自动) = 今天 ≥ 归档日 且 finished_at 为空 → 「超期自动归档」
//   已完成(手动) = finished_at 非空 → 「手动完成」（在哪个阶段点的完成不区分，D10）
//   清除         = 归档日 + 30（自动行，日历日粒度）/ finished_at + 30 天（手动行，
//                  时间戳精确判定）——见 isCleared()
// 「今天」一律按查看设备的本地日历（PRD 9.1-12，与 cards 结算 p_today 同口径）。

import {
  CONTENT_MAX,
  DONE_RETENTION_DAYS,
  DUE_MAX_LOOKAHEAD_DAYS,
  EXPIRED_RETENTION_DAYS,
  NO_DATE_TTL_DAYS,
} from './notesConfig.js'

const DAY_MS = 86400000

// ---------- 日期工具（全走 UTC 毫秒差规避夏令时，同 cardsDomain） ----------

export function todayISO(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function isISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const t = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value
}

function isoToUTC(iso) {
  return Date.parse(`${iso}T00:00:00Z`)
}

export function addDaysISO(iso, days) {
  return new Date(isoToUTC(iso) + days * DAY_MS).toISOString().slice(0, 10)
}

// a − b，单位天（a 晚于 b 为正）
export function diffDays(a, b) {
  return Math.round((isoToUTC(a) - isoToUTC(b)) / DAY_MS)
}

// timestamptz 字符串 → 查看设备本地日历的 YYYY-MM-DD
export function localDayOf(timestamp) {
  return todayISO(new Date(timestamp))
}

// '2026-09-08' → '9月8日'（卡片 meta 用）
export function shortDate(iso) {
  const [m, d] = iso.split('-').slice(1)
  return `${Number(m)}月${Number(d)}日`
}

// ---------- 派生（PRD 3.2 / 8.2） ----------

// 截止日：用户设的日期，或未设时 = 创建日（查看端本地日历）+ 7 天兜底
export function deadlineOf(row) {
  if (row.due_date) return row.due_date
  return addDaysISO(localDayOf(row.created_at), NO_DATE_TTL_DAYS)
}

// 归档日（自动转入已完成的那个日历日；精确时刻 = 该日 00:00）
export function archiveDayOf(row) {
  return addDaysISO(deadlineOf(row), EXPIRED_RETENTION_DAYS + 1)
}

// 'normal' | 'expired' | 'done-auto' | 'done-manual'
export function deriveState(row, today) {
  if (row.kind === 'idea') return 'normal' // 灵感不参与任何流转（D4），永远留在时间线
  if (row.finished_at != null) return 'done-manual'
  const d = diffDays(today, deadlineOf(row))
  if (d <= 0) return 'normal'
  if (d <= EXPIRED_RETENTION_DAYS) return 'expired'
  return 'done-auto'
}

// 进入已完成的时刻（毫秒）——已完成域排序键。手动 = finished_at；自动 = 归档日
// 00:00 的 UTC 锚（仅作单调排序键，展示粒度是日历日）
export function doneMomentMs(row) {
  if (row.finished_at != null) return Date.parse(row.finished_at)
  return isoToUTC(archiveDayOf(row))
}

// 已过清除时刻（8.5）：手动行按 finished_at + 30 天精确判定；自动行按归档日
// + 30 的日历日判定（截止日 + 38 天起视为已清除）
export function isCleared(row, today, nowMs = Date.now()) {
  if (row.finished_at != null) {
    return nowMs >= Date.parse(row.finished_at) + DONE_RETENTION_DAYS * DAY_MS
  }
  if (deriveState(row, today) !== 'done-auto') return false
  return diffDays(today, deadlineOf(row)) >= EXPIRED_RETENTION_DAYS + 1 + DONE_RETENTION_DAYS
}

// 倒计时角标（D5/D6）：只有用户设了日期的正常态备忘才有——null = 不显示
// （无日期备忘的 7 天兜底绝不显示数字，避免被误读成自己设的期限）。
// n = 截止日 − 今天：≥2 还剩 N 天 / 1 明天到期 / 0 今天到期
export function countdownOf(row, today) {
  if (row.kind !== 'memo' || !row.due_date) return null
  if (deriveState(row, today) !== 'normal') return null
  const n = diffDays(deadlineOf(row), today)
  if (n >= 2) return { key: 'days', text: `还剩 ${n} 天` }
  if (n === 1) return { key: 'tomorrow', text: '明天到期' }
  if (n === 0) return { key: 'today', text: '今天到期' }
  return null
}

// 已过期天数（1..7；已过期域徽标与排序键——天数最多的排最前 = 距自动归档最近，D8）
export function expiredDays(row, today) {
  return diffDays(today, deadlineOf(row))
}

// ---------- 分区与排序（PRD 四） ----------

// 'pin' | 'timeline' | 'expired' | 'done'（调用方先滤掉 isCleared 行；
// 置顶只影响正常态条目的分区收录，不豁免流转，D11）
export function zoneOf(row, today) {
  const state = deriveState(row, today)
  if (state === 'normal') return row.pinned ? 'pin' : 'timeline'
  if (state === 'expired') return 'expired'
  return 'done'
}

// 主时间线 / 置顶区：创建时间倒序（D12——位置只讲创建时间）；同刻按 id 定序保证全序
export function sortCreatedDesc(views) {
  return [...views].sort((a, b) => {
    const t = Date.parse(b.row.created_at) - Date.parse(a.row.created_at)
    if (t !== 0) return t
    return a.row.id < b.row.id ? 1 : -1
  })
}

// 已过期域：距自动归档最近（= 已过期天数最多）在前（D8）；并列按创建倒序
export function sortForExpired(views, today) {
  return [...views].sort((a, b) => {
    const d = expiredDays(b.row, today) - expiredDays(a.row, today)
    if (d !== 0) return d
    return Date.parse(b.row.created_at) - Date.parse(a.row.created_at)
  })
}

// 已完成域：进入已完成时刻倒序（9.2-7——最近处理的在上）；并列按创建倒序
export function sortForDone(views) {
  return [...views].sort((a, b) => {
    const d = doneMomentMs(b.row) - doneMomentMs(a.row)
    if (d !== 0) return d
    return Date.parse(b.row.created_at) - Date.parse(a.row.created_at)
  })
}

// 主时间线 · 创建时间升序（旧→新；「仅灵感」反排用，新→旧由 sortCreatedDesc 承担）
export function sortCreatedAsc(views) {
  return [...views].sort((a, b) => {
    const t = Date.parse(a.row.created_at) - Date.parse(b.row.created_at)
    if (t !== 0) return t
    return a.row.id < b.row.id ? 1 : -1
  })
}

// 「仅备忘」截止日排序（2026-09-12 用户裁定 + 澄清：无日期备忘有时效、也参与
// 排序与超期流转）：dir 'near' = 由近到远（截止升序，今天到期最前）、'far' =
// 由远到近（降序）。截止日统一取 deadlineOf（无日期 = 创建日 + 7 派生），
// 无日期备忘按派生截止日自然插序；同截止日按创建倒序。只作用于各备忘模块
// （Pin / 正常 / 已过期 / 已完成）——已过期域 near 即「快被收走的最前」原规则
export function sortForMemoFilter(views, dir) {
  const sign = dir === 'far' ? -1 : 1
  return [...views].sort((a, b) => {
    const d = diffDays(deadlineOf(a.row), deadlineOf(b.row)) * sign
    if (d !== 0) return d
    return Date.parse(b.row.created_at) - Date.parse(a.row.created_at)
  })
}

// 「仅灵感」创建日排序：dir 'old' = 从旧到新；'new'（默认）= 从新到旧
export function sortForIdeaFilter(views, dir) {
  return dir === 'old' ? sortCreatedAsc(views) : sortCreatedDesc(views)
}

// ---------- 展示辅助 ----------

// 相对时间（卡片 meta 右侧；记录场景不做分钟级校时）
export function agoText(timestamp, nowMs = Date.now()) {
  const ms = nowMs - Date.parse(timestamp)
  if (ms < 60_000) return '刚刚'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`
  if (ms < DAY_MS) return `${Math.floor(ms / 3_600_000)} 小时前`
  const days = Math.floor(ms / DAY_MS)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  if (days < 30) return `${Math.floor(days / 7)} 周前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

// 微倾斜（±1.5°，仅存拟物；id 哈希决定、不落库，多端渲染一致——样式稿裁定保留）
const TILTS = [-1.5, -1, 0, 1, 1.5]
export function hashTilt(id) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return TILTS[h % TILTS.length]
}

// ---------- 校验（CF 层与前端表单同源；DB CHECK 兜底不变式见 supabase/notes.sql） ----------

// content：trim 后 1–CONTENT_MAX 字；返回 null = 合法，否则错误文案
export function contentError(raw) {
  if (typeof raw !== 'string') return '内容不能为空'
  const text = raw.trim()
  if (!text) return '内容不能为空'
  if (text.length > CONTENT_MAX) return `内容最多 ${CONTENT_MAX} 字`
  return null
}

// due_date：灵感不可带（D3）；memo 可空，给出时须为 ISO 且 ∈ [today, 今天+7]
// （「今天」按客户端本地日历，伪造仅自伤）
export function dueDateError(dueDate, kind, today) {
  if (dueDate == null || dueDate === '') return null
  if (kind !== 'memo') return '灵感不能设置日期'
  if (!isISODate(dueDate)) return '日期格式无效'
  const n = diffDays(dueDate, today)
  if (n < 0) return '日期不能早于今天'
  if (n > DUE_MAX_LOOKAHEAD_DAYS) {
    return `日期最多选到 ${shortDate(addDaysISO(today, DUE_MAX_LOOKAHEAD_DAYS))}`
  }
  return null
}
