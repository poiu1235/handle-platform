// 容量墙的唯一实现（PRD v3 3.4／3.5／7.4／7.5 第 15 条，✅ D-19 乙随会员上线）。
//
// 🔴 「判墙的代码只写一处、七个入口都调它」（3.4）：漏接一个入口＝一面可以整批灌满的假墙，
//   而 `import.js` 是最容易漏的那个。判据＝scripts/test-pro-cap.mjs 的静态门（入口清单核对）。
//
// 🔴 关态＝现网行为，不是"免费档的新数值"（8.3）：
//   · 便利贴今天就有单一 500 且已在拦 ⇒ 墙关着时**沿用 legacyCap 与原文案**，逐字不变；
//   · 余额与会员卡今天**没有行数墙** ⇒ 墙关着时 legacyCap 传 null，一律放行。
//   两个域走的是同一句"关态"，但形态相反 ⇒ 关态判据必须**分别实测**，只测一页就当另一页也对＝假绿。
//
// ⚠️ 这道墙**不是硬上限**（✅ D-14 已判＝不加锁）：「数行数 → 比较 → 插入」三步之间没有锁或事务，
//   并发双击、并发两批导入都可能小幅超额。危害已算清：多进去的是几条新增行，不动任何存量，
//   与 3.5 的"存量已超上限"同类、用户无损。⇒ 文案与注释都不许写成"最多 N 条／硬上限"，
//   实现者不得假设这里有锁（判据见 test-pro-cap 的措辞静态门与验收 #51）。
import { getProWallState, logProLookupFailure, CAPS } from './proCoverage.js'
import { isGuestEmail } from './guestUser.js'

// 每域一套词。🔴 两类撞墙文案不许互用（7.4）：这里只有"墙上格子"这一类，
// "某周超 5000 字"那一类不许提会员——它归汇聚功能，本模块不产出那种文案。
const WORDS = {
  notes: { label: '便利贴', cleanHint: '删除已过期或已完成的便签' },
  balances: { label: '余额', cleanHint: '删除不再使用的余额条目' },
  cards: { label: '会员卡', cleanHint: '删除过期或用完的会员卡' },
}

/**
 * 撞墙文案。四条约束同时成立：
 *   ① 主体是"额度到了"，不是"你的会员没了"（3.5 ②）；
 *   ② 不许出现"会员已过期，请续费后继续使用"这类暗示锁门的句式（3.5 ①）；
 *   ③ 导出这一支按**账号状态 + 域**分支（D-19）：访客登不进 Web ⇒ 不给做不到的指引；
 *      余额／卡还没有导出功能 ⇒ 也不给（话不许跑在能力前面）。
 *   ④ 存量已超上限时把超出量算出来（3.5：写"已超出 87 条"，不许显示负数）。
 */
export function capMessage({ domain, cap, existing, guest, legacy }) {
  const w = WORDS[domain] || { label: domain, cleanHint: '先清理一些' }
  // 关态的便利贴：逐字沿用现网那句（8.3 关态判据要的就是"症状逐字比对"）
  if (legacy) return `${w.label}已到上限（${cap} 条），先清理一些吧`

  const parts = [`已达 ${w.label} ${cap} 条上限`]
  const over = existing - cap
  if (over > 0) parts.push(`当前已超出 ${over} 条——已有的仍可正常查看和删除，只是不再新增`)
  const exits = [`可${w.cleanHint}`]
  // 🔴 只有便利贴有导出（Web），且访客登不进 Web ⇒ 这一支只对"已绑邮箱 + notes"出现
  if (domain === 'notes' && !guest) exits.push('也可在网页版导出便利贴后整理')
  if (cap === CAPS.free[domain]) {
    exits.push(guest ? '开通会员可提高上限' : '也可开通会员提高上限')
  }
  let msg = parts.join('，') + '。' + exits.join('；') + '。'
  // 访客能看到"绑邮箱"这条既有能力，但它不是付费路径（2.3／7.5 第 3 条同口径）
  if (guest && domain === 'notes') msg += '绑定邮箱后可在网页版导出备份。'
  return msg
}

/**
 * 批量导入的整批预检（3.4：超出 ⇒ **整批不导**，并告知"还能导入 N 条"；不做"导一半"）。
 *
 * 一次 GET 同时拿到两样东西：`Prefer: count=exact` 给物理行数、行本身给已有 key 集合
 * ⇒ 不新增"数一遍再查一遍"的第二次请求。批内同名只算一行（upsert 语义）。
 *
 * 🔴 成本账：这是低频路径（Web 粘贴导入），且只在墙开着时才发这次 GET；关态零额外请求。
 * @param keys 本次载荷里的 key 数组（app_name / name），顺序无所谓
 */
export async function enforceBatchCapacity({ env, accessToken, user, domain, table, keyColumn, keys, legacyCap = null }) {
  let state
  try {
    state = await getProWallState(env, user.id)
  } catch (err) {
    logProLookupFailure(`cap-batch:${domain}`, user.id, err)
    return { allowed: true, cap: null, degraded: true }
  }
  const cap = state.wallsEnabled ? (state.caps ? state.caps[domain] : null) : legacyCap
  if (cap == null) return { allowed: true, cap: null }

  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${table}?select=${keyColumn}&user_id=eq.${encodeURIComponent(user.id)}`,
    {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'count=exact',
      },
    },
  )
  if (!res.ok) {
    // 与单条路径同方向：查不清就放行，不把人挡在记录动作门外（一.5）
    logProLookupFailure(`cap-batch-read:${domain}`, user.id, new Error(`HTTP ${res.status}`))
    return { allowed: true, cap, degraded: true }
  }
  const range = res.headers.get('content-range') || ''
  const existing = range.includes('/') ? Number(range.split('/')[1]) : NaN
  if (!Number.isFinite(existing)) return { allowed: true, cap }
  const rows = await res.json().catch(() => [])
  const known = new Set((Array.isArray(rows) ? rows : []).map((r) => r[keyColumn]))

  const fresh = new Set()
  for (const k of keys) if (!known.has(k)) fresh.add(k)
  const newCount = fresh.size
  if (existing + newCount <= cap) return { allowed: true, cap }

  const w = WORDS[domain] || { label: domain }
  const room = Math.max(cap - existing, 0)
  // ⚠️ Web 没有购买入口（2.4）⇒ 指路必须指向真实存在的唯一收款处（3.4 第二十一轮第 8 条），
  //    且不许写成"绑定邮箱即可开通"那种把导流当付费路径的话。
  // ⚠️ 余额／卡还没有导出功能（D-19 丙未落地）⇒ 这里不许提"网页版导出全部数据"。
  return {
    allowed: false,
    status: 409,
    cap,
    error:
      `已达 ${w.label} ${cap} 条上限：本次 ${newCount} 条是新增，超出上限。` +
      `整批未导入，你还能导入 ${room} 条。可先删除一些，或在手机微信里打开 Handle 小程序开通会员提高上限。`,
  }
}

/** 物理行数（HEAD count，与 notes 现有做法同形）。拿不到 ⇒ NaN，调用方按"放行"处理 */
export async function countRows(env, accessToken, table, userId) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?select=id&user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'HEAD',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'count=exact',
    },
  })
  const range = res.headers.get('content-range') || ''
  const n = range.includes('/') ? Number(range.split('/')[1]) : NaN
  return Number.isFinite(n) ? n : NaN
}

/**
 * 唯一的判墙入口。
 * @param existing  当前物理行数（NaN ⇒ 放行，不挡关键路径）
 * @param incoming  本次要新增的行数（批量导入传 rows.length）
 * @param dedupe    upsert 语义用：{ table, column, value }。临界时多花一次 GET 判断
 *                  "这条是不是覆盖已有行"——覆盖不增行，拦它就是违反一.5「记录动作免费」。
 *                  只在临界点才查，正常路径零额外请求。
 */
export async function enforceCapacity({ env, accessToken, user, domain, existing, incoming = 1, legacyCap = null, dedupe = null }) {
  let state
  try {
    state = await getProWallState(env, user.id)
  } catch (err) {
    // 🔴 7.2 写路径：查询报错 ⇒ **放行**并留可定位日志；不写任何状态位（写了就把 D-2
    //    撤掉的可写派生态请回来）。也别以为有人会收到通知——6.5 已定 V1 没有推送型告警。
    logProLookupFailure(`cap:${domain}`, user.id, err)
    return { allowed: true, cap: null, degraded: true }
  }

  const legacy = !state.wallsEnabled
  const cap = legacy ? legacyCap : (state.caps ? state.caps[domain] : null)
  if (cap == null) return { allowed: true, cap: null } // 该域此刻没有墙
  if (!Number.isFinite(existing)) return { allowed: true, cap } // 数不出来 ⇒ 放行（沿用现网语义）
  if (existing + incoming <= cap) return { allowed: true, cap }

  // 临界：upsert 覆盖已有行不产生新行 ⇒ 放行。查这一条只在临界发生。
  if (dedupe && incoming === 1) {
    try {
      const hit = await fetch(
        `${env.SUPABASE_URL}/rest/v1/${dedupe.table}?select=id&user_id=eq.${encodeURIComponent(user.id)}` +
          `&${dedupe.column}=eq.${encodeURIComponent(dedupe.value)}&limit=1`,
        { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` } },
      )
      const rows = await hit.json().catch(() => [])
      if (Array.isArray(rows) && rows.length > 0) return { allowed: true, cap }
    } catch (err) {
      logProLookupFailure(`cap-dedupe:${domain}`, user.id, err)
      return { allowed: true, cap, degraded: true } // 查不清就放行，不把人挡在记录动作门外
    }
  }

  return {
    allowed: false,
    status: 409,
    cap,
    error: capMessage({ domain, cap, existing, guest: isGuestEmail(user.email), legacy }),
  }
}
