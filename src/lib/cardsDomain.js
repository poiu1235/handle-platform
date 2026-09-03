// 生活会员 · 前端推导契约（src/cards-db.md 第 8 节）：无任何请求的纯函数模块。
// 输入 = 全量行（snake_case）+ 今天（本地时区 YYYY-MM-DD），输出 = 状态 / 展示分组 /
// 结构化提醒（PRD 3.3.4）与导入预览分类（S15）。常量全部来自 shared/cardsConfig.js，
// 与 Cloudflare 层共用同一份配置，前后端零口径分叉。
//
// 状态公理（PRD 3.0/3.2）：状态单轴由 DDL 推导；"次数用完"与"静默"是正交的数据条件，
// 不产生状态、不影响循环；到期提醒被"次数用完"排除，扣款提醒只被"已过期/静默"排除。

import {
  BILLING_REMINDER_DAYS,
  DDL_MAX_HORIZON_YEARS,
  EXPIRY_REMINDER_DAYS,
  START_DATE_MAX_LOOKBACK_YEARS,
} from '../../shared/cardsConfig.js'

// ── 日期工具 ──────────────────────────────────────────────────────────────
// 全部走 UTC 毫秒差，规避夏令时；年/月推进与 PostgreSQL `date + interval`
// 的日历钳制同语义（2/29 → 2/28），保证与 SQL 侧物化默认值一致。

export function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isoToUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

export function isISODate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && isValidStrict(value)
}

// 严格校验年月日（Date.UTC 会把 2/30 归一化成 3/2，必须回读比对）
function isValidStrict(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export function diffDays(fromISO, toISO) {
  return Math.round((isoToUTC(toISO) - isoToUTC(fromISO)) / 86400000)
}

export function addYearsClamped(iso, n) {
  const [y, m, d] = iso.split('-').map(Number)
  const targetY = y + n
  const daysInMonth = new Date(Date.UTC(targetY, m, 0)).getUTCDate()
  return `${targetY}-${String(m).padStart(2, '0')}-${String(Math.min(d, daysInMonth)).padStart(2, '0')}`
}

// 固定天数推进（UTC 毫秒差，无钳制漂移）
export function addDaysISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

// 日历月推进（与 PostgreSQL date + interval 'N month' 同语义：月末钳制 1/31 → 2/28）
export function addMonthsClamped(iso, n) {
  const [y, m, d] = iso.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  const targetY = Math.floor(total / 12)
  const targetM = (total % 12) + 1
  const daysInMonth = new Date(Date.UTC(targetY, targetM, 0)).getUTCDate()
  return `${targetY}-${String(targetM).padStart(2, '0')}-${String(Math.min(d, daysInMonth)).padStart(2, '0')}`
}

// 扣款日随周期的窗口上限（用户裁定 2026-09-02：扣款日只能选在本周期内）：
// 周 = 今天+7；月 = +1 月；季 = +3 月；年 = +1 年；fixed = 今天 + period_days − 1
// （"到固定期限前日期"）。未知/不完整周期返回 null（调用方回退配置 B 上限）。
export function billingMaxForCycle(today, cycleKey, periodDays) {
  switch (cycleKey) {
    case 'week':
      return addDaysISO(today, 7)
    case 'month':
      return addMonthsClamped(today, 1)
    case 'quarter':
      return addMonthsClamped(today, 3)
    case 'year':
      return addYearsClamped(today, 1)
    case 'fixed':
      return Number.isInteger(periodDays) && periodDays > 0 ? addDaysISO(today, periodDays - 1) : null
    default:
      return null
  }
}

// 接受 2026-9-3 / 2026.9.3 / 2026/9/3 → 'YYYY-MM-DD'；无效返回 null（仅导入解析内部使用）
function normalizeDateText(text) {
  const m = String(text).trim().match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/)
  if (!m) return null
  const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  return isValidStrict(iso) ? iso : null
}

export function shortDate(iso) {
  const [, m, d] = iso.split('-')
  return `${m}-${d}`
}

// 详情 meta 行的日期格式（PRD 5.4 示例：2025.09.20 − 2026.09.19）
export function dotDate(iso) {
  return iso.replaceAll('-', '.')
}

// ── 配置窗口（配置 A/B 的前端读数；CF 层用同一配置做同样的校验） ────────────
export const startDateMin = (today) => addYearsClamped(today, -START_DATE_MAX_LOOKBACK_YEARS)
export const ddlMax = (today) => addYearsClamped(today, DDL_MAX_HORIZON_YEARS)

// ── 记录色（6.5：生活卡青绿-紫罗兰系色板，id 哈希取色不变色） ───────────────
const CARD_PALETTE = [
  '#a9dace', '#b7e5df', '#a2e4e2', '#bbe0e3', '#a8d7e2',
  '#b6dbeb', '#adcbdf', '#bbd1e9', '#a6bfe8', '#bfcae8',
  '#abb5e6', '#c3c5e6', '#b3b0e4', '#c7bfed', '#c2b5e2',
  '#d3c4ec', '#cdb0ea',
]

function hashString(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0
  return h
}

export function colorForCard(id) {
  return CARD_PALETTE[hashString(String(id)) % CARD_PALETTE.length]
}

// ── 单卡视图（PRD 3.2 状态与展示条件 + 3.3.1 窗口与排除 + 3.3.4 结构化输出） ──
export function deriveCardView(row, today) {
  const expired = today > row.end_date
  const daysToDdl = diffDays(today, row.end_date)
  const hasSessions = row.remaining_sessions !== null && row.remaining_sessions !== undefined
  const usedUp = hasSessions && row.remaining_sessions === 0
  const muted = row.muted === 'cycle' || row.muted === 'forever'
  const daysToBilling =
    row.auto_renew && row.next_billing_date && (row.billing_cycle || row.period_days) ? diffDays(today, row.next_billing_date) : null

  // 提醒排除按 reason.type 独立判定（4-B10）：expiring 受"次数用完"排除；
  // billing 不受任何用量条件影响。两类窗口共同排除：已过期、静默。
  const reminders = { expiring: null, billing: null }
  if (!expired && !muted) {
    if (!usedUp && daysToDdl <= EXPIRY_REMINDER_DAYS) {
      reminders.expiring = { type: 'expiring', deadline: row.end_date, daysLeft: daysToDdl }
    }
    if (daysToBilling !== null && daysToBilling <= BILLING_REMINDER_DAYS) {
      reminders.billing = { type: 'billing', deadline: row.next_billing_date, daysLeft: daysToBilling }
    }
  }

  // 沉底（2026-09-02 裁定修订）：expired 恒沉底；次数用完**仅在未开自动续费时**
  // 沉底——还在续费的卡即使次数用完也不沉底（下个周期结算会重置次数，沉底展示
  // 反而误导）；纯"次数用完 + 未续费"才是资格暂尽的弱化色沉底
  const sunkReason = expired ? 'expired' : usedUp && !row.auto_renew ? 'used_up' : null

  return {
    row,
    status: expired ? 'expired' : 'active',
    displayGroup: sunkReason ? 'sunk' : 'normal',
    sunkReason,
    daysToDdl,
    daysToBilling,
    hasSessions,
    usedUp,
    muted,
    reminders,
    // 4-B14 防御性兜底：历史数据可能存在"续费开但缺扣款日/周期"的形态（不结算不提醒）
    renewIncomplete:
      !!row.auto_renew &&
      (!row.next_billing_date || (!row.billing_cycle && !row.period_days)),
  }
}

// ── 折叠态/半展开右侧主信息（5.4：剩余天数恒为主信息〔右槽，列表按天对齐〕；
// 次卡在左槽并排"剩 N 次"。扣款窗口内右槽换扣款倒计时——它也是天数语义）──
function billingCountdown(days) {
  if (days <= 0) return '今天扣款'
  return `${days} 天后扣款`
}

export function collapsedInfo(view) {
  const tags = []
  if (view.status === 'expired') return { main: '已过期', count: null, tags }
  const count = view.hasSessions ? `剩 ${view.row.remaining_sessions} 次` : null
  // "已用完"独占主信息仅限未开续费的沉底卡（2026-09-02 裁定：用完 + 续费中
  // 不沉底、不失效——下个周期结算会重置次数，照常显示天数/扣款倒计时）
  if (view.usedUp && !view.row.auto_renew) {
    // 命中扣款窗口 → 追加独立小标签（4-B12：沉底不等于对钱失明）
    if (view.reminders.billing) tags.push({ key: 'billing', text: billingTag(view) })
    return { main: '已用完', count: null, tags }
  }
  const { expiring, billing } = view.reminders
  if (billing && (!expiring || view.daysToBilling <= view.daysToDdl)) {
    return { main: billingCountdown(view.daysToBilling), count, tags }
  }
  // 到期提醒窗口与常态同文案（剩 N 天），不再单列分支
  return { main: `剩 ${view.daysToDdl} 天`, count, tags }
}

// ── 进站 alert 模型（3.3.4 结构化输出；会话去重在调用方用内存标志实现） ──────
export function buildAlert(views) {
  const entries = []
  for (const v of views) {
    const reasons = []
    if (v.reminders.expiring) reasons.push(v.reminders.expiring)
    if (v.reminders.billing) reasons.push(v.reminders.billing)
    if (reasons.length === 0) continue
    entries.push({
      cardId: v.row.id,
      name: v.row.name,
      reasons,
      usedUp: v.usedUp,
      muted: v.muted,
      displayGroup: v.displayGroup,
      color: colorForCard(v.row.id),
    })
  }
  if (entries.length === 0) return null
  return entries.sort(
    (a, b) => Math.min(...a.reasons.map((r) => r.daysLeft)) - Math.min(...b.reasons.map((r) => r.daysLeft))
  )
}

// ── 清单排序（5.1）：沉底规则见 deriveCardView（expired 恒沉底；次数用完仅在
// 未开自动续费时沉底）─────────────────────────────────────────────────────
export function sortCardViews(views, sortKey, sortDir = 'asc') {
  const pinyinCollator = (() => {
    try {
      return new Intl.Collator('zh-Hans-CN-u-co-pinyin', { sensitivity: 'base' })
    } catch {
      return null
    }
  })()
  const dir = sortDir === 'desc' ? -1 : 1

  return [...views].sort((a, b) => {
    // 沉底预分组（规则见 deriveCardView：expired 恒沉底；次数用完仅在未开自动续费时沉底）
    const groupDelta = (a.displayGroup === 'normal' ? 0 : 1) - (b.displayGroup === 'normal' ? 0 : 1)
    if (groupDelta !== 0) return groupDelta
    if (sortKey === 'name') {
      const cmp = pinyinCollator
        ? pinyinCollator.compare(a.row.name, b.row.name)
        : a.row.name.localeCompare(b.row.name)
      return dir * (cmp || (a.row.name < b.row.name ? -1 : a.row.name > b.row.name ? 1 : 0))
    }
    if (sortKey === 'updated') {
      // 按更新时间（updated_at 由表级 trigger 自动维护，cards-db.md 4.1）
      const ta = Date.parse(a.row.updated_at || '') || 0
      const tb = Date.parse(b.row.updated_at || '') || 0
      return dir * (ta < tb ? -1 : ta > tb ? 1 : 0)
    }
    // 按 DDL（升序 = 最先到期的在前）：自动续费卡的 DDL ≡ 扣款日（用户裁定
    // 2026-09-02：写入两侧同步、结算 RPC 成对推进），end_date 一个键即同时覆盖
    // 到期与扣款两种关注点——不再需要"取两者近者"的关键日定义
    return dir * a.row.end_date.localeCompare(b.row.end_date)
  })
}

// ── 批量导入：解析 → 批内合并 → 预览分类（PRD 3.6.3 / S15） ─────────────────

export const FIELD_LABELS = {
  start_date: '起始日期',
  end_date: '终止日期',
  remaining_sessions: '剩余次数',
  total_sessions: '每周期次数',
  auto_renew: '自动续费',
  billing_cycle: '扣款周期',
  period_days: '合同天数',
  next_billing_date: '扣款日',
}

const DIFF_FIELDS = Object.keys(FIELD_LABELS)

const HEADER_ALIASES = {
  name: ['卡名', '名称', '卡片名', '项目'],
  start_date: ['起始日', '起始日期', '开始日期', '开始日'],
  end_date: ['终止日期', '终止日', '到期日', '截止日期', '有效期至', 'ddl'],
  remaining_sessions: ['剩余次数', '剩余', '余次'],
  total_sessions: ['每周期次数', '总次数', '共'],
  auto_renew: ['自动续费', '续费'],
  billing_cycle: ['扣款周期', '周期'],
  period_days: ['合同天数', '天数'],
  next_billing_date: ['扣款日', '下次扣款日', '下次扣款', '扣款日期'],
}

// 无表头时的默认列序（与导入页占位文案一致）
const DEFAULT_COLUMNS = [
  'name', 'start_date', 'end_date', 'remaining_sessions',
  'total_sessions', 'auto_renew', 'billing_cycle', 'period_days', 'next_billing_date',
]

const CYCLE_TEXT = { week: '周', month: '月', quarter: '季', year: '年' }

function matchHeaderField(text) {
  const t = String(text).trim().toLowerCase()
  if (!t) return null
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.some((a) => a.toLowerCase() === t)) return field
  }
  return null
}

function splitLine(line) {
  if (line.includes('\t')) return line.split('\t')
  if (line.includes(',')) return line.split(',')
  return line.trim().split(/\s+/)
}

function parseCell(field, rawText) {
  const text = String(rawText).trim()
  if (text === '') return { missing: true }
  switch (field) {
    case 'name':
      return { value: text }
    case 'start_date':
    case 'end_date':
    case 'next_billing_date': {
      const iso = normalizeDateText(text)
      return iso ? { value: iso } : { error: `${FIELD_LABELS[field]}「${text}」不是有效日期` }
    }
    case 'remaining_sessions':
    case 'total_sessions':
    case 'period_days': {
      if (!/^-?\d+$/.test(text)) return { error: `${FIELD_LABELS[field]}「${text}」不是整数` }
      return { value: Number(text) }
    }
    case 'auto_renew': {
      const t = text.toLowerCase()
      if (['是', 'true', '1', 'y', 'yes', '开'].includes(t)) return { value: true }
      if (['否', 'false', '0', 'n', 'no', '关'].includes(t)) return { value: false }
      return { error: `自动续费「${text}」无法识别（用 是/否）` }
    }
    case 'billing_cycle': {
      const key = Object.keys(CYCLE_TEXT).find((k) => k === text.toLowerCase())
      const zh = Object.entries(CYCLE_TEXT).find(([, zh2]) => zh2 === text)
      const resolved = key || (zh && zh[0])
      return resolved
        ? { value: resolved }
        : { error: `扣款周期「${text}」无法识别（周/月/季/年）` }
    }
    default:
      return { missing: true }
  }
}

// 解析粘贴文本：首行命中 ≥2 个表头别名时按表头取列，否则按默认列序。
// 返回行对象只携带行内出现的字段（缺失字段 = 键不出现 = 保留现值/取默认，3.6.3）。
export function parseCardsText(text) {
  const lines = String(text)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)

  const rows = []
  const errors = []
  let columns = null

  lines.forEach((line, idx) => {
    const cells = splitLine(line)
    if (columns === null) {
      const mapped = cells.map(matchHeaderField)
      if (mapped.filter(Boolean).length >= 2) {
        columns = mapped
        return
      }
      columns = DEFAULT_COLUMNS
    }

    const row = { __line: idx + 1 }
    let hasName = false
    for (let c = 0; c < cells.length; c++) {
      const field = columns[c]
      if (!field) continue
      const parsed = parseCell(field, cells[c])
      if (parsed.missing) continue
      if (parsed.error) {
        errors.push({ line: idx + 1, raw: line, reason: parsed.error })
        continue
      }
      row[field] = parsed.value
      if (field === 'name') hasName = true
    }

    if (!hasName) {
      if (Object.keys(row).filter((k) => k !== '__line').length === 0) {
        errors.push({ line: idx + 1, raw: line, reason: '缺少字段（至少需要 卡名 一列）' })
      } else {
        errors.push({ line: idx + 1, raw: line, reason: '卡名为空' })
      }
      return
    }
    rows.push(row)
  })

  return { rows, errors }
}

// 批内同名合并：同卡名逐字段取最后一个非缺失值（3.6.3；行号取最后一次出现）
export function mergeImportRows(rows) {
  const byKey = new Map()
  for (const r of rows) {
    const key = (r.name || '').trim()
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, { ...r })
      continue
    }
    for (const k of Object.keys(r)) {
      if (k === '__line') continue
      if (r[k] !== undefined && r[k] !== null) prev[k] = r[k]
    }
    prev.__line = r.__line
  }
  return Array.from(byKey.values())
}

function valueEquals(a, b) {
  const norm = (v) => (v === undefined || v === null || v === '' ? null : v)
  return norm(a) === norm(b)
}

function stripRow(row) {
  const { __line, ...rest } = row
  return rest
}

// 预览分类（S15）：v2 无冲突组——一切差异都是"更新"。
// 每组行带 3.6.2 三分支去向（update | update_to_expired | skip_expired | insert_expired
// | insert）与「字段 | 旧值 → 新值」对照；落库同规则在 import_my_cards 内实现。
export function classifyImport(mergedRows, loadedCards, today) {
  const creates = []
  const updates = []
  const errors = []
  const minStart = startDateMin(today)
  const maxDdl = ddlMax(today)
  const byKey = new Map(loadedCards.map((r) => [r.name, r]))

  for (const row of mergedRows) {
    const name = (row.name || '').trim()
    const existing = byKey.get(name)
    const line = row.__line

    if (!name) {
      errors.push({ line, reason: '缺少卡名' })
      continue
    }
    // —— 行级校验（3.6.3 校验细则；与 CF 层 7.5 清单同则）——
    if (row.start_date != null && (row.start_date < minStart || row.start_date > today)) {
      errors.push({ line, reason: `起始日期需在 ${minStart} 至 ${today} 之间（配置 A）` })
      continue
    }
    if (row.end_date != null) {
      const effStart = row.start_date ?? existing?.start_date ?? today
      if (row.end_date > maxDdl) {
        errors.push({ line, reason: `终止日期不能晚于 ${maxDdl}（配置 B）` })
        continue
      }
      if (row.end_date < effStart) {
        errors.push({ line, reason: '终止日期早于起始日期' })
        continue
      }
    }
    if (row.billing_cycle != null && row.period_days != null) {
      errors.push({ line, reason: '扣款周期与合同天数只能二选一' })
      continue
    }
    if (row.total_sessions != null && row.total_sessions <= 0) {
      errors.push({ line, reason: '每周期次数需大于 0' })
      continue
    }
    if (row.remaining_sessions != null && row.remaining_sessions < 0) {
      errors.push({ line, reason: '剩余次数不能为负数' })
      continue
    }
    if (row.period_days != null && row.period_days <= 0) {
      errors.push({ line, reason: '合同天数需为正整数' })
      continue
    }

    if (!existing) {
      // —— 新增行：缺失取默认；auto_renew=true 缺周期/天数 → 行报错（4-B27，
      //    DB CHECK cards_renew_complete 要求扣款日非空 + 周期二选一）——
      // 用户裁定 2026-09-03（二次修订）：续费行扣款日一律强制 = 生效 DDL，行内
      // 显式扣款日忽略——对齐"续费卡 DDL ≡ 扣款日"全站不变式；缺省 DDL 则
      // 物化默认今天 + 配置 B
      if (row.auto_renew === true) {
        if (row.billing_cycle == null && row.period_days == null) {
          errors.push({ line, reason: '开启自动续费需选择扣款周期或填写合同天数' })
          continue
        }
        row.next_billing_date = row.end_date ?? addYearsClamped(today, DDL_MAX_HORIZON_YEARS)
      }
      if (row.total_sessions != null && row.remaining_sessions == null) {
        errors.push({ line, reason: '新增行只带每周期次数、缺剩余次数' })
        continue
      }
      const rowDead = row.end_date != null && row.end_date < today
      creates.push({
        row: stripRow(row),
        line,
        action: rowDead ? 'insert_expired' : 'insert',
        defaults: [
          row.start_date == null && { label: '起始日期', value: '今天' },
          row.end_date == null && { label: '终止日期', value: `今天 + ${DDL_MAX_HORIZON_YEARS} 年` },
          row.auto_renew == null && { label: '自动续费', value: '关' },
          row.auto_renew === true && { label: '扣款日', value: row.next_billing_date },
        ].filter(Boolean),
        sessionsOn: row.remaining_sessions != null,
      })
      continue
    }

    // —— 更新行：三分支去向（3.6.2）——
    const rowDead = row.end_date != null && row.end_date < today
    const existingExpired = existing.end_date < today
    let action = 'update'
    if (rowDead && existingExpired) action = 'skip_expired'
    else if (rowDead) action = 'update_to_expired'

    // 4-B31：能力未开启 → 次数字段组打包忽略（宽容忽略、不自动重开）
    const capabilityOff = existing.remaining_sessions == null
    const ignoredSessions =
      capabilityOff && (row.remaining_sessions != null || row.total_sessions != null)
    // B26/宽容忽略：解析出的自动续费为关 → 行内扣款字段忽略不写
    const resolvedRenew = row.auto_renew ?? existing.auto_renew
    const ignoredBilling =
      !resolvedRenew &&
      (row.next_billing_date != null || row.billing_cycle != null || row.period_days != null)

    // 旧 → 新对照：只列变化字段；镜像 SQL 落库的互斥清洗（写任一非空表示 → 置空另一字段）。
    // eff = 合成后的落库行（coalesce 缺失保留现值 + 互斥清洗 + 忽略字段不写）
    const eff = { ...existing }
    const writeFields = DIFF_FIELDS.filter((f) => {
      if (capabilityOff && (f === 'remaining_sessions' || f === 'total_sessions')) return false
      if (ignoredBilling && (f === 'billing_cycle' || f === 'period_days' || f === 'next_billing_date')) return false
      // 用户裁定 2026-09-03（二次修订）：续费行扣款日一律 = 生效 DDL，行内
      // 显式扣款日不参与写入（下方统一赋值，diff 如实显示 旧 → 新）
      if (resolvedRenew && f === 'next_billing_date') return false
      return row[f] !== undefined
    })
    for (const field of writeFields) {
      if (field === 'period_days' && row[field] != null) eff.billing_cycle = null
      if (field === 'billing_cycle' && row[field] != null) eff.period_days = null
      eff[field] = row[field]
    }

    // 4-B27 合并态校验（用户裁定 2026-09-03 二次修订）：扣款日一律强制 = 生效
    // 终止日期（行内 > 库内，见 eff.end_date 的合成序），行内显式扣款日忽略——
    // 对齐"续费卡 DDL ≡ 扣款日"全站不变式；周期/天数仍必须完整，否则 SQL UPDATE
    // 必撞 cards_renew_complete 并整批回滚，预览阶段行报错拦截（SQL RPC 同规则兜底）
    if (resolvedRenew) {
      if (eff.billing_cycle == null && eff.period_days == null) {
        errors.push({
          line,
          reason: '自动续费为开，但缺少扣款周期或合同天数（行内未携带且库内现值为空），请在行内补全',
        })
        continue
      }
      eff.next_billing_date = eff.end_date
    }

    const diff = DIFF_FIELDS.filter((f) => !valueEquals(existing[f], eff[f])).map((f) => ({
      field: f,
      label: FIELD_LABELS[f],
      old: existing[f] ?? null,
      new: eff[f] ?? null,
    }))

    updates.push({
      row: stripRow(row),
      line,
      existing,
      action,
      diff,
      ignoredSessions,
      ignoredBilling,
    })
  }

  return { creates, updates, errors }
}

export function formatFieldValue(field, value) {
  if (value === null || value === undefined || value === '') return '（空）'
  if (field === 'auto_renew') return value ? '开' : '关'
  if (field === 'billing_cycle') return CYCLE_TEXT[value] ? `每${CYCLE_TEXT[value]}` : value
  return String(value)
}

// 提交载荷：新增 + 更新（含跳过行，RPC 内同规则跳过）；忽略的字段不进载荷
export function buildImportPayload(classification) {
  const rows = []
  for (const c of classification.creates) rows.push(stripRow(c.row))
  for (const u of classification.updates) {
    const row = { ...u.row }
    if (u.ignoredSessions) {
      delete row.remaining_sessions
      delete row.total_sessions
    }
    if (u.ignoredBilling) {
      delete row.billing_cycle
      delete row.period_days
      delete row.next_billing_date
    }
    rows.push(row)
  }
  return rows
}
