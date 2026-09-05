import { json } from '../_lib/supabase.js'
import {
  DDL_MAX_HORIZON_YEARS,
  START_DATE_MAX_LOOKBACK_YEARS,
  addYearsClamped,
  billingMaxForCycle,
  dateWindowError,
  intError,
  isISODate,
  isValidCycle,
  isValidMuted,
  restHeaders,
  todayISO,
} from './cards/_lib.js'

// 转发的是用户自己的 access token（_middleware.js 已验签、排除 recovery），
// cards 表 RLS（user_id 归属）继续生效；本层只做配置窗口/枚举/次数规则校验
// 与字段白名单（src/cards-db.md 7.2 / 第 12 节）。

// ── GET：进站加载 = 结算 + 全量拉取一次完成（请求预算 1.2；PRD 3.3.3 lazy settlement）──
export async function onRequestGet(context) {
  const { env, data, request } = context
  // 结算"今天" = 客户端本地日期（预留 #8 口径，与展示层同源）：DB current_date
  // 是 UTC，UTC+8 本地 0–8 点间会晚一天，导致续费卡"界面已过期、结算未追赶"；
  // 非法/缺失回退服务器日期（护栏校验，伪造仅自伤——追的是用户自己的卡）
  const t = new URL(request.url).searchParams.get('today')
  const today = isISODate(t) ? t : todayISO()
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/settle_my_cards`, {
    method: 'POST',
    headers: restHeaders(env, data.accessToken),
    body: JSON.stringify({ p_today: today }),
  })
  const body = await res.json().catch(() => null)
  if (body === null) return json({ error: '结算请求失败' }, 502)
  return json(body, res.status)
}

// ── POST：单条添加（S1）——同名 = 覆盖（3.6.1 唯一键 upsert）。
// merge-duplicates 冲突更新只 SET payload 携带的列，未携带字段保留现值（9.9）。
export async function onRequestPost(context) {
  const { env, data, request } = context
  const payload = await request.json().catch(() => ({}))
  // 窗口校验"今天"口径（预留 #8 / 评审二 2.2）：用客户端传入的本地日期，
  // 避免服务器 UTC 在 UTC+8 的 0–8 点把"起始日 = 今天"误拒；非法则回退服务器
  // 日期（护栏校验，伪造仅自伤）。RPC 内部仍用 DB current_date。
  const today = isISODate(payload.today) ? payload.today : todayISO()
  const minStart = addYearsClamped(today, -START_DATE_MAX_LOOKBACK_YEARS)
  const maxDdl = addYearsClamped(today, DDL_MAX_HORIZON_YEARS)

  // —— 白名单 + trim（user_id 从 token 注入；v3：卡名即展示名，无 merchant 列）——
  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  if (!name) return json({ error: '卡名不能为空' }, 400)
  const row = { name, user_id: data.user.id }

  // 起始日（4-B3：可改历史，配置 A）
  if (payload.start_date != null) {
    const err = dateWindowError(payload.start_date, minStart, today, '起始日期')
    if (err) return json({ error: err }, 400)
    row.start_date = payload.start_date
  }

  // 终止日：缺失 → 物化"今天 + 配置 B"（4-B5；v3：不再记录物化标记）；
  // 显式给出则校验 [起始日?, 今天+配置B]（跨 start 的交叉校验由 DB CHECK cards_end_after_start 兜底）
  if (payload.end_date == null || payload.end_date === '') {
    row.end_date = addYearsClamped(today, DDL_MAX_HORIZON_YEARS)
  } else {
    if (!isISODate(payload.end_date)) return json({ error: '终止日期格式无效' }, 400)
    if (payload.end_date > maxDdl) {
      return json({ error: `终止日期不能晚于 ${maxDdl}（配置 B）` }, 400)
    }
    if (row.start_date && payload.end_date < row.start_date) {
      return json({ error: '终止日期不能早于起始日期' }, 400)
    }
    row.end_date = payload.end_date
  }

  // 次数（手动路径：开启必填 remaining > 0，5.5；显式 null = 关闭能力 → total 联动双清，4-B31）
  const remainingProvided = payload.remaining_sessions !== undefined
  const totalProvided = payload.total_sessions !== undefined
  if (remainingProvided && payload.remaining_sessions !== null) {
    const err = intError(payload.remaining_sessions, '剩余次数', { min: 1 })
    if (err) return json({ error: `${err}（开启次数能力时剩余次数必填且需大于 0）` }, 400)
    row.remaining_sessions = Number(payload.remaining_sessions)
  } else if (remainingProvided) {
    row.remaining_sessions = null
    row.total_sessions = null // cards_count_pair：关闭必须双清，否则是 DB 拒绝的非法态
  }
  if (totalProvided && payload.total_sessions !== null) {
    if (row.remaining_sessions === null) {
      return json({ error: '已请求关闭次数能力，不能再携带每周期次数' }, 400)
    }
    const err = intError(payload.total_sessions, '每周期次数', { min: 1 })
    if (err) return json({ error: err }, 400)
    row.total_sessions = Number(payload.total_sessions)
  } else if (totalProvided) {
    row.total_sessions = null
  }

  // 自动续费开关 + 周期信息（互斥：同填 400；写一种非空表示 → 机械置空另一种，
  // cards_cycle_exclusive 的实现手段）。auto_renew=false 时携带的扣款字段宽容忽略
  // （4-B26）——注意校验先于忽略：即使字段将被丢弃，格式/枚举非法仍先 400
  // （比 B26 字面更严格的防御性设计：垃圾枚举值永不落库，复核 2026-08-31 #6）
  if (payload.auto_renew !== undefined) {
    if (typeof payload.auto_renew !== 'boolean') return json({ error: 'auto_renew 需为布尔值' }, 400)
    row.auto_renew = payload.auto_renew
  }
  if (payload.billing_cycle != null && payload.period_days != null) {
    return json({ error: '扣款周期与合同天数只能二选一' }, 400)
  }
  if (payload.billing_cycle != null) {
    if (!isValidCycle(payload.billing_cycle)) return json({ error: '扣款周期枚举无效' }, 400)
    if (row.auto_renew !== false) {
      row.billing_cycle = payload.billing_cycle
      row.period_days = null
    }
  } else if (payload.period_days != null) {
    const err = intError(payload.period_days, '合同天数', { min: 1 })
    if (err) return json({ error: err }, 400)
    if (row.auto_renew !== false) {
      row.period_days = Number(payload.period_days)
      row.billing_cycle = null
    }
  }
  // 显式清空一种表示（独立处理，两者可同时为 null——续费中且无另一表示时
  // cards_renew_complete 拒绝透传）
  if (payload.billing_cycle === null) row.billing_cycle = null
  if (payload.period_days === null) row.period_days = null

  if (payload.next_billing_date != null) {
    // 手动路径窗口 = 周期限窗（用户裁定 2026-09-02，5.7 表单同则）；B26：显式关续费时宽容忽略
    if (row.auto_renew !== false) {
      const cycleKey = payload.billing_cycle ?? null
      const days = payload.period_days != null ? Number(payload.period_days) : null
      let upper = cycleKey ? billingMaxForCycle(today, cycleKey, days) : null
      if (!upper && days != null) upper = billingMaxForCycle(today, 'fixed', days)
      const err = dateWindowError(payload.next_billing_date, today, upper ?? maxDdl, '扣款日')
      if (err) return json({ error: err }, 400)
      row.next_billing_date = payload.next_billing_date
    }
  } else if (payload.next_billing_date === null) {
    row.next_billing_date = null
  }

  // DDL ≡ 扣款日（用户裁定 2026-09-02）：续费开启时有效期跟随扣款日（同值）——
  // 扣款窗口天然覆盖"有效期"，两者恒统一；显式携带 end_date 时以显式值为准
  if (row.auto_renew === true && row.next_billing_date != null && !('end_date' in payload)) {
    row.end_date = row.next_billing_date
  }

  // 4-B27（7.2）：auto_renew=true ⇒ 扣款日 + 周期二选一必须在 payload 内
  // （表单开启时三字段一起提交；要"维持"既有续费态则不携带 auto_renew）
  if (row.auto_renew === true) {
    if (row.next_billing_date == null) {
      return json({ error: '开启自动续费需填写下次扣款日' }, 400)
    }
    if (row.billing_cycle == null && row.period_days == null) {
      return json({ error: '开启自动续费需选择扣款周期或填写合同天数' }, 400)
    }
  }

  if (payload.muted !== undefined) {
    if (!isValidMuted(payload.muted)) return json({ error: '静默枚举无效' }, 400)
    row.muted = payload.muted
  }

  // 图标（v3.2，对齐 balances.icon_key）：null = 恢复自动匹配；非空 = 清单 key。
  // 不校验 key 是否真存在于清单——展示层 onError 自带菱形点回退（伪造仅自伤）
  if (payload.icon_key !== undefined) {
    if (payload.icon_key === null) {
      row.icon_key = null
    } else {
      if (typeof payload.icon_key !== 'string') return json({ error: 'icon_key 需为字符串或 null' }, 400)
      const iconKey = payload.icon_key.trim()
      if (!iconKey) return json({ error: 'icon_key 不能为空字符串（清空请传 null）' }, 400)
      if (iconKey.length > 64) return json({ error: 'icon_key 过长' }, 400)
      row.icon_key = iconKey
    }
  }

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/cards?on_conflict=user_id,name`, {
    method: 'POST',
    headers: restHeaders(env, data.accessToken, {
      Prefer: 'resolution=merge-duplicates,return=representation',
    }),
    body: JSON.stringify(row),
  })
  const body = await res.json().catch(() => ({}))
  return json(body, res.status)
}
