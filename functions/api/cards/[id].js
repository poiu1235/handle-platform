import { json } from '../../_lib/supabase.js'
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
} from '../cards/_lib.js'

// 全部单卡变更（S6/S9/S10/S11/S12 前置/S16）与删卡（S12）。
// PATCH 只转发 payload 携带的字段（PostgREST 只 SET 携带的列，其余保留现值）；
// muted='cycle' 的顺延解除由 cards_muted_reset 触发器按 end_date 实际变化统一执行（4-B22）。

// ── PATCH：顺延 / 改次数 / 清零 / 标记用完 / 静默 / 续费开关与周期信息 / 编辑起始日 ──
export async function onRequestPatch(context) {
  const { env, data, request, params } = context
  const payload = await request.json().catch(() => ({}))
  // 窗口校验"今天"口径（预留 #8 / 评审二 2.2）：客户端本地日期优先，非法回退
  // 服务器日期；`today` 不在白名单内，不会进入转发载荷
  const today = isISODate(payload.today) ? payload.today : todayISO()
  const minStart = addYearsClamped(today, -START_DATE_MAX_LOOKBACK_YEARS)
  const maxDdl = addYearsClamped(today, DDL_MAX_HORIZON_YEARS)

  // 本卡现名（改名唯一性预检的比对基准；取不到 = 卡不存在/不属于该用户 → 空，
  // 预检放行后由下方 UPDATE 的 0 行兜底 404）
  let row0Name = null
  {
    const cur = await fetch(
      `${env.SUPABASE_URL}/rest/v1/cards?select=name&id=eq.${params.id}`,
      { headers: restHeaders(env, data.accessToken) }
    )
    const curBody = await cur.json().catch(() => [])
    if (Array.isArray(curBody) && curBody.length > 0) row0Name = curBody[0].name
  }

  // —— 字段白名单——
  // name（2026-09-02 裁定放开改名，行为对齐余额：改名是普通编辑；唯一性预检
  // 防 PostgREST 直改撞唯一键返回不可读的 23505——同名返回 400「已有同名卡券」。
  // trim 后精确匹配（与导入/单条添加同则）；改成本卡现名 = 无操作，不携带）
  const row = {}

  if (payload.name !== undefined) {
    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    if (!name) return json({ error: '卡名不能为空' }, 400)
    if (name !== row0Name) {
      const dup = await fetch(
        `${env.SUPABASE_URL}/rest/v1/cards?select=id&user_id=eq.${data.user.id}&name=eq.${encodeURIComponent(name)}`,
        { headers: restHeaders(env, data.accessToken) }
      )
      const dupBody = await dup.json().catch(() => [])
      if (Array.isArray(dupBody) && dupBody.length > 0) {
        return json({ error: '已有同名卡券，请换一个名字' }, 400)
      }
      row.name = name
    }
  }

  if (payload.start_date !== undefined) {
    const err = dateWindowError(payload.start_date, minStart, today, '起始日期')
    if (err) return json({ error: err }, 400)
    row.start_date = payload.start_date
  }
  if (payload.end_date !== undefined) {
    // 手动窗口 [今天, 今天+配置B]（4-B2；顺延 ≥ 今天，可多次累积）
    const err = dateWindowError(payload.end_date, today, maxDdl, '终止日期')
    if (err) return json({ error: err }, 400)
    row.end_date = payload.end_date
  }

  // 次数：改次数/清零/标记用完（= 改 0）；显式 null = 关闭能力（4-B31，两个字段联动双清）
  if (payload.remaining_sessions !== undefined) {
    if (payload.remaining_sessions === null) {
      row.remaining_sessions = null
      row.total_sessions = null // cards_count_pair：关闭必须双清
    } else {
      const err = intError(payload.remaining_sessions, '剩余次数', { min: 0 })
      if (err) return json({ error: err }, 400)
      row.remaining_sessions = Number(payload.remaining_sessions)
    }
  }
  if (payload.total_sessions !== undefined) {
    if (payload.total_sessions === null) {
      row.total_sessions = null
    } else {
      if (row.remaining_sessions === null) {
        return json({ error: '已请求关闭次数能力，不能再携带每周期次数' }, 400)
      }
      const err = intError(payload.total_sessions, '每周期次数', { min: 1 })
      if (err) return json({ error: err }, 400)
      row.total_sessions = Number(payload.total_sessions)
    }
  }

  // 续费开关与周期信息（互斥清洗同 POST）。校验先于宽容忽略：auto_renew=false
  // 时携带的扣款字段虽被丢弃（4-B26），格式/枚举非法仍先 400（防御性设计，复核 #6）
  if (payload.auto_renew !== undefined) {
    if (typeof payload.auto_renew !== 'boolean') return json({ error: 'auto_renew 需为布尔值' }, 400)
    row.auto_renew = payload.auto_renew
    // 关闭续费 → 周期刷新次数一并置 null（2026-09-02 裁定，服务端兜底防直调；
    // remaining 不动——次数能力本身保留）
    if (payload.auto_renew === false) row.total_sessions = null
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
  if (payload.billing_cycle === null) row.billing_cycle = null
  if (payload.period_days === null) row.period_days = null

  if (payload.next_billing_date !== undefined) {
    if (payload.next_billing_date === null) {
      row.next_billing_date = null // 续费中清空会撞 cards_renew_complete，透传给前端展示
    } else if (row.auto_renew !== false) {
      // 周期限窗（用户裁定 2026-09-02）：扣款日 ∈ [今天, 本周期上限]。周期表示
      // 取 payload 携带值，缺失回退库内现值（维护路径兜底）；两者皆空 → 配置 B。
      const cycleKey = payload.billing_cycle ?? null
      const days = payload.period_days ?? null
      let upper = cycleKey ? billingMaxForCycle(today, cycleKey, days) : null
      if (!upper && days != null) upper = billingMaxForCycle(today, 'fixed', Number(days))
      const err = dateWindowError(payload.next_billing_date, today, upper ?? maxDdl, '扣款日')
      if (err) return json({ error: err }, 400)
      row.next_billing_date = payload.next_billing_date
      // DDL ≡ 扣款日（用户裁定 2026-09-02）：写扣款日必同步写 end_date（同值），
      // 除非同一载荷已显式携带 end_date（显式优先）
      if (payload.end_date === undefined) row.end_date = payload.next_billing_date
    }
  }

  // 4-B20 重开/开启闸门（第 12 节预留 #1）：PATCH 含 auto_renew=true ⇒ 必须同时
  // 携带扣款日 + 周期表示之一——"重开必须重设"是跃迁语义，DB CHECK 只兜最终态非空
  if (row.auto_renew === true) {
    const carriedDate = payload.next_billing_date != null
    const carriedCycle = payload.billing_cycle != null || payload.period_days != null
    if (!carriedDate || !carriedCycle) {
      return json({ error: '重开自动续费需重新填写扣款日与周期' }, 400)
    }
    // 开启跃迁：DDL 跟随本次扣款日（未显式携带 end_date 时）
    if (payload.end_date === undefined) row.end_date = row.next_billing_date
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

  if (Object.keys(row).length === 0) {
    return json({ error: '没有可更新的字段' }, 400)
  }

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/cards?id=eq.${params.id}`, {
    method: 'PATCH',
    headers: restHeaders(env, data.accessToken, { Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return json(body, res.status)
  if (!Array.isArray(body) || body.length === 0) {
    // RLS 过滤后 0 行 = 不属于该用户或不存在（7.3；DELETE 与此处故意不对称）
    return json({ error: '卡片不存在或无权访问' }, 404)
  }
  return json(body, 200)
}

// ── DELETE：删卡（S12，唯一不可逆）——幂等，removed 由返回行数得出 ──
export async function onRequestDelete(context) {
  const { env, data, params } = context
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/cards?id=eq.${params.id}`, {
    method: 'DELETE',
    headers: restHeaders(env, data.accessToken, { Prefer: 'return=representation' }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    return json(body, res.status)
  }
  const body = await res.json().catch(() => [])
  // 200 { removed: 0|1 }——与其他端点故意不对称（评审 #4）：对"不存在/不属于该用户"
  // 返回 200 而非 404，同时避免调试期"传错 id 也看起来成功"
  return json({ ok: true, removed: Array.isArray(body) ? body.length : 0 })
}
