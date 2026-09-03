// cards 端点共用的小工具：转发头、日期与配置窗口校验。
// 配置常量与前端共用 shared/cardsConfig.js（DB CHECK 不承载可调配置，
// 见 src/cards-db.md 2.1 校验分层），改配置不会出现前后端口径分叉。

import {
  BILLING_CYCLES,
  DDL_MAX_HORIZON_YEARS,
  MUTED_MODES,
  START_DATE_MAX_LOOKBACK_YEARS,
} from '../../../shared/cardsConfig.js'

export function restHeaders(env, accessToken, extra = {}) {
  return {
    'Content-Type': 'application/json',
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken}`,
    ...extra,
  }
}

// "今天"取服务器时钟（UTC）；与用户本地时区的偏差 ≤ 1 天，PRD 4-B8 明示可接受
export function todayISO() {
  return new Date().toISOString().slice(0, 10)
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

// 日历月推进（月末钳制 1/31 → 2/28，与 SQL date + interval 同语义）
export function addMonthsClamped(iso, n) {
  const [y, m, d] = iso.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  const targetY = Math.floor(total / 12)
  const targetM = (total % 12) + 1
  const daysInMonth = new Date(Date.UTC(targetY, targetM, 0)).getUTCDate()
  return `${targetY}-${String(targetM).padStart(2, '0')}-${String(Math.min(d, daysInMonth)).padStart(2, '0')}`
}

// 扣款日随周期的窗口上限（用户裁定 2026-09-02：扣款日只能选在本周期内）：
// 周 = 今天+7；月 = +1 月；季 = +3 月；年 = +1 年；fixed = 今天 + period_days − 1。
// 周期不完整返回 null（调用方回退配置 B 上限——维护路径不携带周期时的兜底）
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

export function isISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export const CYCLE_KEYS = BILLING_CYCLES.map((c) => c.key)

export function isValidCycle(value) {
  return CYCLE_KEYS.includes(value)
}

export function isValidMuted(value) {
  return MUTED_MODES.includes(value)
}

// 配置 A/B 窗口（4-B2 / 4-B3 / 5.7 扣款日；返回错误文案或 null）
export function dateWindowError(value, min, max, label) {
  if (!isISODate(value)) return `${label}格式无效`
  if (value < min || value > max) return `${label}需在 ${min} 至 ${max} 之间`
  return null
}

export function intError(value, label, { min }) {
  const n = Number(value)
  if (!Number.isInteger(n)) return `${label}需为整数`
  if (n < min) return `${label}需不小于 ${min}`
  return null
}

export { START_DATE_MAX_LOOKBACK_YEARS, DDL_MAX_HORIZON_YEARS }
