import { json } from '../../_lib/supabase.js'
import {
  DDL_MAX_HORIZON_YEARS,
  START_DATE_MAX_LOOKBACK_YEARS,
  addYearsClamped,
  dateWindowError,
  intError,
  isISODate,
  isValidCycle,
  restHeaders,
  todayISO,
} from './_lib.js'

// 批量导入提交（S2/S15）：CF 层逐行校验（7.5 清单）+ 剥离显式 null 值键后
// 转发 rpc/import_my_cards——三分支与合并全部在 SQL 内完成，一次请求。
// 前端已在预览阶段完成同名合并、逐行校验与三分支标注（classifyImport），
// 这里的校验是防直调绕过的兜底；任一行失败整批回滚（RPC 内事务）。

const ALLOWED_FIELDS = new Set([
  'name',
  'start_date',
  'end_date',
  'remaining_sessions',
  'total_sessions',
  'auto_renew',
  'billing_cycle',
  'period_days',
  'next_billing_date',
])

export async function onRequestPost(context) {
  const { env, data, request } = context
  const { rows, today: clientToday } = await request.json().catch(() => ({}))
  if (!Array.isArray(rows) || rows.length === 0) {
    return json({ error: '没有可提交的数据' }, 400)
  }

  // 窗口校验"今天"口径（预留 #8 / 评审二 2.2）：客户端本地日期优先，非法回退
  // 服务器日期；RPC 内的行判定过期 / 物化默认仍用 DB current_date（两套口径
  // ≤1 天偏差为 4-B8 接受范围）。`today` 不在白名单内，不会进入转发载荷
  const today = isISODate(clientToday) ? clientToday : todayISO()
  const minStart = addYearsClamped(today, -START_DATE_MAX_LOOKBACK_YEARS)
  const maxDdl = addYearsClamped(today, DDL_MAX_HORIZON_YEARS)
  const cleaned = []

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] || {}
    const lineNo = i + 1
    const fail = (reason) => json({ error: `第 ${lineNo} 行：${reason}` }, 400)

    // trim 后判空（7.5：缺卡名 → 行报错；RPC 内对匹配与写入也做 trim。
    // v3：卡名即展示名，merchant 列已合并进 name，不再单独校验）
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name) return fail('缺少卡名')
    const row = { name }

    for (const [key, value] of Object.entries(raw)) {
      // 白名单 + 显式 null 值键剥离（显式 null 视同缺失，第 6 节缺失字段语义）；
      // name 已在上方 trim 并判空，跳过避免未 trim 值回填
      if (!ALLOWED_FIELDS.has(key) || key === 'name') continue
      if (value === null || value === undefined) continue
      row[key] = value
    }

    if (row.start_date !== undefined) {
      const err = dateWindowError(row.start_date, minStart, today, '起始日期')
      if (err) return fail(err)
    }
    if (row.end_date !== undefined) {
      if (!isISODate(row.end_date)) return fail('终止日期格式无效')
      // 导入不校验"≥ 起始日"的交叉关系（有效起始日可能在库内，CF 不读库）——
      // DB CHECK cards_end_after_start 兜底，预览分类已在 JS 侧按快照校验过
      if (row.end_date > maxDdl) return fail(`终止日期不能晚于 ${maxDdl}（配置 B）`)
    }
    if (row.remaining_sessions !== undefined) {
      const err = intError(row.remaining_sessions, '剩余次数', { min: 0 })
      if (err) return fail(err)
    }
    if (row.total_sessions !== undefined) {
      const err = intError(row.total_sessions, '每周期次数', { min: 1 })
      if (err) return fail(err)
    }
    if (row.period_days !== undefined) {
      const err = intError(row.period_days, '合同天数', { min: 1 })
      if (err) return fail(err)
    }
    if (row.auto_renew !== undefined && typeof row.auto_renew !== 'boolean') {
      return fail('auto_renew 需为布尔值')
    }
    if (row.billing_cycle !== undefined && !isValidCycle(row.billing_cycle)) {
      return fail('扣款周期枚举无效')
    }
    // 行内同时携带两表示 → 拒绝（RPC 同款兜底；预览已行报错）
    if (row.billing_cycle !== undefined && row.period_days !== undefined) {
      return fail('扣款周期与合同天数只能二选一')
    }
    // 扣款日不校验窗口（第 9 节 8：v2 校验细则未列，扫描主权 + 人工核对兜住），只查格式
    if (
      row.next_billing_date !== undefined &&
      !isISODate(row.next_billing_date)
    ) {
      return fail('扣款日格式无效')
    }

    cleaned.push(row)
  }

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/import_my_cards`, {
    method: 'POST',
    headers: restHeaders(env, data.accessToken),
    body: JSON.stringify({ p_rows: cleaned }),
  })
  const body = await res.json().catch(() => null)
  if (body === null) return json({ error: '导入请求失败' }, 502)
  return json(body, res.status)
}
