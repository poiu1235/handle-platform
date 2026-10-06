// POST /admin/pro-anomaly —— 🔴 **`anomaly` 单的出边**（PRD v3 4.5 第 7 步"anomaly 必须有出边"；
// 4.6 入口④；B5①）。三种收口，每一条都留痕：
//
//   action      含义                     平台必须怎么答（`query_order` 的归类，见 EVIDENCE）
//   ─────────────────────────────────────────────────────────────────────────────────────
//   credit      改判成**入账**            paid
//   refunded    钱已回用户，标**已退款**  refunded
//   closed      这单根本没付过，标**关闭** unpaid／closed／not_found
//
// 为什么这一支要存在：4.5 第 7 步的原话是"没有出边的异常单＝一张永远查不完的表"。今天 A3 巡检
// （`pro-ops.sql`，`where status='anomaly'`）能看见它们，但库里**没有任何一条代码路径**能把它们
// 推走——唯一的做法是在 Dashboard 手打 UPDATE，而那正是 4.6 点名禁止的形状（绕过 4.5 的全部校验；
// 涉及账本的话还绕过 7.6 那条"永不允许手工发权益"的铁律）。E-19 那笔遗留单就是这么躺下来的。
//
// 🔴 为什么在 `functions/admin/` 而不是 `/api/**`：与 `/admin/pro-refunds` 同一条理由——
//   `functions/_middleware.js` 对所有 `/api/**` 一律要用户 Bearer 且没有豁免机制。挂到那下面，
//   任何登录用户都能把自己那张"钱与货对不上"的单标成已入账（⇒ 系统去给他发权益）。
//   凭证＝同一把 `PRO_ADMIN_TOKEN`，门＝同一个 `_lib/proAdminGuard.js`（缺 secret 回 503，
//   不是 401：配置缺失不许长得像"凭证不对"，2026-10-05 那次握手排障就是被这类混淆拖了一轮）。
//
// 🔴 **每一次收口都先问一次平台**，三种 action 都要（不只是 `credit`）。理由分两头：
//   · `credit` 那一头是正本写死的：4.6 入口④"『只有已确认已付才允许补写』**由代码强制，不靠纪律**"，
//     7.6 那行"补写已核实订单的账本"之所以是 ✅ 也以此为前提；
//   · `refunded`／`closed` 那一头是同一类危害的反方向：把一张其实还付着钱的单标成终态，
//     症状是"钱在平台、权益在我方账本上却没了、而且 A3 从此不再显示它"——那比"多一条异常单"更坏，
//     因为它是**静默**的。让平台答一次就把这种收口挡在写之前，成本是一次人工点击才发的出网调用。
//   查单失败（`error`／`unreachable`）⇒ 503 且**零写**：与 4.5 三态表同一条纪律，"没查到"
//   永远折不成"没付"或"已退"。
//
// 🔴 `credit` 那一支**不自己写 paid、不自己写账本行**：它先做一次带留痕的 CAS 把行交回
//   `pending`，然后调用 `proCredit.creditOrder`——那是全仓唯一那份"查单→回填 paid→判
//   is_duplicate→写账本→发货告知"的实现（4.6"写这三张表的模块只有一个"、7.6"走与推送
//   **同一个入账事务**"）。为什么不许给 `creditOrder` 加一个 `allowAnomaly` 参数：那条
//   "anomaly 拒绝复活"的门（4.5 第 3 步）禁的是**自动触发源**不绕过人工，一旦它接受一个
//   调用方传进来的布尔，任何新调用方都能顺手把 anomaly 单入账——门就从"结构"退化成"纪律"。
//   交还给 `pending` 之后它是自愈态（轮询／进站／重推都认得 pending），而不是死路态。
//
// ⚠️ 写序：`refunded` 那一支**先撤账本行、后改订单状态**（与 `proCredit.refundOrder`、
//   管理端 `done` 同一方向）。中间断开的残余是"权益已撤而订单还挂着原状态"——方向对
//   （钱已回用户），且重放这一支会收敛（撤 0 行、CAS 这次能成）；反过来就留下
//   "订单说已退款、权益却还在"，那正是 E-20② 判成硬前置的那个现场。
import { json } from '../_lib/supabase.js'
import { adminTokenGate, adminTraceGate } from '../_lib/proAdminGuard.js'
import {
  getOrderForAdminByOutTradeNo,
  liveLedgerExistsForOrder,
  resolveAnomalyOrder,
  revokeLedgerForOrder,
} from '../_lib/proStore.js'
import { classifyQueryResult, xpayOrderOf, xpayPaidTime, xpayQueryOrder } from '../_lib/proXpay.js'
import { creditOrder } from '../_lib/proCredit.js'

const ACTIONS = ['credit', 'refunded', 'closed']
/** 🔴 有出边的状态只有这两种。`paid`／`refunded`／`closed` 再收一次就是改历史（那是另一件事）。 */
const ADMITTABLE = ['anomaly', 'pending']
/**
 * 三种收口各自要平台怎么答——这张表是本端点真正的门，删掉它等于"管理员说了算"。
 * `closed` 吃三档：`unpaid`（还开着没付）／`closed`（平台也关了）／`not_found`（平台查无此单）
 * 在"根本没付过"这一格上是同一个事实。
 */
const EVIDENCE = {
  credit: ['paid'],
  refunded: ['refunded'],
  closed: ['unpaid', 'closed', 'not_found'],
}
/** `note` 是**追加**不是覆盖：那行原本写着"为什么进的 anomaly"，它是这条链的来路 */
const NOTE_SEP = ' ⟶ '

function badRequest(error, code) {
  return json({ error, code }, 400)
}

/**
 * 把凭据写进留痕（D-9a：`note` 要能回答"怎么核实的"，将来被追责时读的是这一列，不是 CF 日志）。
 * 🔴 只取三个字段：整个回包塞进一列 text 会把这条链变成取证垃圾场。
 * `refund_info.refund_order` 是**数组**（2026-10-05 已退真单第一次露出来，正本 R-9 ⑪），
 * 一笔可分多次退 ⇒ 那些回执号是这一格唯一落点（这张表上没有 `wx_refund_id` 列）。
 */
function evidenceOf(q) {
  const o = xpayOrderOf(q) || {}
  const list = o.refund_info && Array.isArray(o.refund_info.refund_order) ? o.refund_info.refund_order : []
  const parts = [`status=${o.status === undefined ? '?' : o.status}`, `paid_fee=${o.paid_fee === undefined ? '?' : o.paid_fee}`]
  if (list.length) parts.push(`refund_order=${list.join(',')}`)
  return parts.join(' ')
}

/** 留痕那一句：来路（行里原来的 note）＋ 这次的判断 ＋ 谁做的 ＋ 凭据 */
function traceNote(prev, action, operator, noteText, q) {
  const added = `admin:${action} by ${operator}｜${noteText}｜查单 ${evidenceOf(q)}`
  const p = String(prev || '').trim()
  return p ? p + NOTE_SEP + added : added
}

/** CAS 匹配 0 行＝这一行在我们读完之后被人（轮询／推送／另一个管理员）改过 ⇒ 不静默成 200 */
function raced(from) {
  return json({ error: `这一行已经不是 ${from} 了 ⇒ 什么都不再动，刷新后重新判断`, code: 'anomaly_raced', now: null }, 409)
}

/**
 * 入账那一步之后回读"库里到底长什么样"：状态、付款时刻、名下是否真有活着的权益。
 * 读失败按"没落地"报（🔴 不许把读不到当成成功），因为这一格的用途就是替人省掉一条 select。
 */
async function verifyCoverage(env, { outTradeNo, uuid }) {
  try {
    const after = await getOrderForAdminByOutTradeNo(env, outTradeNo)
    const live = await liveLedgerExistsForOrder(env, String(uuid))
    return { status: after ? String(after.status) : null, paidAt: after ? after.paid_at || null : null, coverageLive: live }
  } catch (err) {
    console.error('[admin/anomaly] verify read failed:', (err && err.code) || 'unknown')
    return { status: null, paidAt: null, coverageLive: false }
  }
}

export async function onRequestPost(context) {
  const { request, env } = context
  const gate = adminTokenGate(request, env, 'admin/anomaly')
  if (gate) return gate

  let body = null
  try {
    body = await request.json()
  } catch {
    return badRequest('请求体不是 JSON', 'bad_request')
  }
  const outTradeNo = String((body && body.outTradeNo) || '').trim()
  const action = String((body && body.action) || '')
  if (!outTradeNo) return badRequest('缺少单号（我方 `out_trade_no`，A3/A10 第一列那个）', 'bad_request')
  if (!ACTIONS.includes(action)) return badRequest('action 只能是 credit／refunded／closed', 'bad_request')
  // D-9a：人工收口必须留痕"谁做的、怎么核实的"。`pro_orders` 侧没有 E-29 那两条 CHECK
  // ⇒ 这一道门今天**只有代码里这一份**，删掉它等于把留痕要求删掉（判据＝`test:anomaly` 6.3）。
  const tr = adminTraceGate(body)
  if (tr.res) return tr.res
  const { operator, note } = tr

  let row = null
  try {
    row = await getOrderForAdminByOutTradeNo(env, outTradeNo)
  } catch (err) {
    console.error('[admin/anomaly] read failed:', (err && err.code) || 'unknown')
    return json({ error: '暂时无法处理，请稍后再试', code: 'pro_unavailable' }, 503)
  }
  if (!row) return json({ error: '没有这张订单', code: 'no_such_order' }, 404)
  const from = String(row.status)
  if (!ADMITTABLE.includes(from)) {
    // 🔴 终态不许再收一次：把 `refunded` 改成 `closed`、把 `paid` 标成 `refunded`，写的都不是
    //   事实而是历史，且没有任何一层会去核对。回当前状态，让管理员知道这一行已经定案。
    return json({ error: '这一行已经是终态或已入账，管理端不出边', code: 'not_closable', now: from }, 409)
  }
  if (!row.id) return json({ error: '订单行读不到主键 ⇒ 无法做带条件的改判', code: 'no_order_id' }, 503)
  if (!row.payer_openid) {
    // 没有 `payer_openid` 就没法问平台（`query_order` 必带 openid），也就没有凭据可写。
    // 🔴 不许"那就先按管理员说的办"：这一行来路不明，正是要人看的那种。
    return json({ error: '这一行没有 payer_openid，无法向平台核对 ⇒ 先人工核实来源', code: 'no_payer_openid' }, 409)
  }

  // ── 事实确认：一次查单，三种收口共用同一道门 ────────────────────────────────
  const q = await xpayQueryOrder({
    env,
    openid: String(row.payer_openid),
    orderId: outTradeNo,
    envFlag: Number(row.env) === 1 ? 1 : 0,
  })
  const kind = classifyQueryResult(q)
  if (kind === 'error' || kind === 'unreachable') {
    console.error('[admin/anomaly] query failed, nothing written:', JSON.stringify({ outTradeNo, kind, errcode: q.errcode }))
    return json(
      { error: '平台查单没成功 ⇒ 什么都不改（"没查到"不是"没付过"，也不是"已退"）', code: 'query_unavailable', errcode: q.errcode ?? null, errmsg: q.errmsg || '' },
      503,
    )
  }
  if (!EVIDENCE[action].includes(kind)) {
    return json(
      {
        error: `平台答的是「${kind}」，与 ${action} 不符 ⇒ 什么都不改`,
        code: 'evidence_mismatch',
        action,
        platformSays: kind,
        supportedActions: Object.keys(EVIDENCE).filter((a) => EVIDENCE[a].includes(kind)),
      },
      409,
    )
  }

  const noteText = traceNote(row.note, action, operator, note, q)

  // ── credit：交还给唯一那份入账实现（本端点不写 paid、不写账本行）─────────────
  if (action === 'credit') {
    let cas = null
    try {
      cas = await resolveAnomalyOrder(env, { orderId: String(row.id), fromStatus: from, toStatus: 'pending', operator, note: noteText })
    } catch (err) {
      console.error('[admin/anomaly] hand-off write failed:', (err && err.code) || 'unknown')
      return json({ error: '暂时无法处理，请稍后再试', code: 'pro_unavailable' }, 503)
    }
    if (!cas.matched) return raced(from)
    const cr = await creditOrder(env, outTradeNo)
    if (cr.outcome === 'credited' || cr.outcome === 'already') {
      // 🔴 回"库里现在是什么样"，不是"我这次写了什么"：入账那两步是分开的（改状态、插账本行），
      //   而 E-19 的现场恰恰是"只成了后半"。多读一次（人工点击才发得出，频次上限＝1 次/点击）
      //   换的是这一格不需要人再去跑一条 select。
      const v = await verifyCoverage(env, { outTradeNo, uuid: String(row.id) })
      console.log('[admin/anomaly] credited:', JSON.stringify({ outTradeNo, from, outcome: cr.outcome, verify: v }))
      return json({
        outTradeNo,
        action,
        from,
        outcome: cr.outcome,
        // `already`＝账本上本来就有这一单的行（E-19 那种"账本写成、订单没改成"从这里自动并回来）
        status: v.status,
        paidAt: v.paidAt,
        coverageLive: v.coverageLive,
        // 交了还权却没落地＝这一格还要人看，别让它顶着 200 走出去
        verifyFailed: !v.coverageLive,
      })
    }
    // 🔴 没入成账，但行已经是 `pending` 了 ⇒ 它不再出现在 A3（那按 status='anomaly' 筛）。
    //   接住它的是 A4（pending 且已过 `expires_at`）与端上那两层查单——必须把这句话写出口，
    //   否则这一格就成了"异常单从一张能查的表里凭空消失"，那比留着更坏。
    console.error('[admin/anomaly] handed to creditOrder but it did not credit:', JSON.stringify({ outTradeNo, from, outcome: cr.outcome, stage: cr.stage || null }))
    return json(
      {
        error: '已把行交还给入账，但入账这一步没成 ⇒ 这一行现在是 pending（A3 不再显示它，由 A4 或端上补查接手）；修好原因（多半是道具期限读不到）再点一次',
        code: 'credit_incomplete',
        outTradeNo,
        action,
        from,
        now: 'pending',
        creditOutcome: cr.outcome,
        stage: cr.stage || null,
      },
      503,
    )
  }

  // ── refunded：先把权益撤干净，再改状态 ─────────────────────────────────────
  if (action === 'refunded') {
    // 🔴 只在**真要回填**时才带 `paid_at`：那一列是 7 天窗口的起点，已有值的行一个字都不许碰。
    //   重写一遍同样的值看着无害，但"这一列被谁动过"从此分不清——E-19 那颗 bug 查了整整一轮。
    let paidAtIso = null
    if (!row.paid_at) {
      // 库侧 CHECK：`status not in ('paid','refunded') or paid_at is not null` ⇒ `paid_at` 为空的行
      // 标成 refunded 会让整条 PATCH 抛 23514。E-19 那笔遗留单正是这一格（账本行写成了、
      // `paid_at` 从没回填），所以这里按**平台给的付款时刻**回填；平台也没给 ⇒ 零写拒掉，
      // 🔴 绝不拿"本次时刻"冒充付款时刻（它是 7 天窗口的起点，那一列写进去就是编的）。
      const p = xpayPaidTime(q)
      if (!p.ok) {
        return json({ error: '这一行 paid_at 为空，而平台这次没给出可用的付款时刻 ⇒ 什么都不改', code: 'refund_needs_paid_at', raw: p.raw ?? null }, 409)
      }
      paidAtIso = p.iso
    }
    let rv = null
    try {
      rv = await revokeLedgerForOrder(env, String(row.id))
    } catch (err) {
      console.error('[admin/anomaly] ledger revoke failed:', (err && err.code) || 'unknown')
      return json({ error: '暂时无法处理，请稍后再试', code: 'pro_unavailable' }, 503)
    }
    // 撤 0 行有两种可能（这单从没入账过／权益早被撤过），**两种都不是错误**，但也不能叫"已撤"：
    // 那一格塌成布尔，读的人就分不出"我们从没发过权益"和"有人先撤过"。
    const ledgerMoved = rv.matched > 0 ? 'revoked' : 'nothing_to_revoke'
    let cas = null
    try {
      cas = await resolveAnomalyOrder(env, { orderId: String(row.id), fromStatus: from, toStatus: 'refunded', paidAtIso, operator, note: noteText })
    } catch (err) {
      console.error('[admin/anomaly] mark refunded failed after revoke:', JSON.stringify({ outTradeNo, ledgerMoved, code: (err && err.code) || 'unknown' }))
      return json({ error: '暂时无法处理，请稍后再试', code: 'pro_unavailable' }, 503)
    }
    if (!cas.matched) {
      console.error('[admin/anomaly] ledger moved but the order row was not there anymore:', JSON.stringify({ outTradeNo, ledgerMoved }))
      return json({ error: '权益已按方向动过，但这一行刚被人改过状态 ⇒ 刷新后核对', code: 'anomaly_raced', ledgerMoved }, 409)
    }
    console.log('[admin/anomaly] refunded:', JSON.stringify({ outTradeNo, from, ledgerMoved, paidAtBackfilled: !row.paid_at }))
    return json({ outTradeNo, action, from, status: 'refunded', ledgerMoved, paidAtBackfilled: !row.paid_at })
  }

  // ── closed：只关"根本没付过"的，且绝不用它撤权益 ────────────────────────────
  let live = false
  try {
    live = await liveLedgerExistsForOrder(env, String(row.id))
  } catch (err) {
    console.error('[admin/anomaly] live ledger read failed:', (err && err.code) || 'unknown')
    return json({ error: '暂时无法处理，请稍后再试', code: 'pro_unavailable' }, 503)
  }
  if (live) {
    // 🔴 `closed` 的语义是"没付过"，而它名下还有活着的权益 ⇒ 这一支绝不顺手撤销：
    //   撤权益只有两条正当来源（退款申请 `done`／外部退款回流），都要钱真的回到用户手里。
    //   真退了钱就走 `refunded`；没退就别动，让 A3 继续看得见它。
    return json(
      { error: '这一单名下还有未撤销的账本行 ⇒ closed 不许当撤权益的通道（那语义是"没付过"）。真退了钱走 refunded，否则别动它', code: 'closed_would_drop_coverage' },
      409,
    )
  }
  let casClosed = null
  try {
    casClosed = await resolveAnomalyOrder(env, { orderId: String(row.id), fromStatus: from, toStatus: 'closed', operator, note: noteText })
  } catch (err) {
    console.error('[admin/anomaly] mark closed failed:', (err && err.code) || 'unknown')
    return json({ error: '暂时无法处理，请稍后再试', code: 'pro_unavailable' }, 503)
  }
  if (!casClosed.matched) return raced(from)
  console.log('[admin/anomaly] closed:', JSON.stringify({ outTradeNo, from, platformSays: kind }))
  return json({ outTradeNo, action, from, status: 'closed', ledgerMoved: 'none_live' })
}
