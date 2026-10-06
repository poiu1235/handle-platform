// POST /admin/pro-refunds —— 管理端把退款申请推到终态（4.6 入口④；PRD v3 6.1 退款执行、D-22）
//
// 🔴 为什么在 `functions/admin/` 而不是 `functions/api/pro/admin/`：这一支的凭证**不是用户 Bearer**。
//   挂在 `/api/**` 下会先被那层中间件按"已登录用户"放行——任何登录用户都能把自己的申请标成
//   `done`（然后系统去撤自己的账，钱却没退）。所以它走 `/api/**` 之外，自己认一把独立 secret
//   （`PRO_ADMIN_TOKEN`，`wrangler pages secret put`）。缺这把 secret ⇒ 503，🔴 不是"没有门"。
//
// 🔴 这一支**没有**"执行退款"的按钮（D-22：我方不调退款接口）。管理员做的事是：
//   去微信/小程序后台手工退那笔钱，然后回来把申请标 `done` 并填上后台给的回执号。
//
// 写序：两条动作都**先动账本、后改申请行**。理由不是偏好，是可恢复性——
//   · `done`：先撤账（钱真退了 ⇒ 权益必须在）；改行失败 ⇒ 管理员重试，撤账幂等（匹配 0 行），终态一致。
//   · `rejected`：先还权益（不退款 ⇒ 权益本来就该在）；改行失败 ⇒ 重试同样收敛。
//   反过来（先改行）会留下"行已是终态、账本没跟上"的形状，而那时这一支的 `status=eq.pending`
//   过滤会把重试挡在门外——只剩手工改库一条路。
import { json } from '../_lib/supabase.js'
import { adminTokenGate, adminTraceGate } from '../_lib/proAdminGuard.js'
import {
  getRefundRequest,
  getOrderById,
  refundRequestsByOrders,
  finalizeRefundRequest,
  revokeLedgerForOrder,
  unrevokeLedgerForOrder,
} from '../_lib/proStore.js'

function badRequest(error, code) {
  return json({ error, code }, 400)
}

export async function onRequestPost(context) {
  const { request, env } = context
  // 🔴 两道门与 `/admin/pro-anomaly` **共用同一个实现**（`_lib/proAdminGuard.js`）：同一把 secret、
  //   同一个"缺配置回 503 而不是 401"、同一条 operator＋note 必填。抄两份＝留一条会漂移的门。
  const gate = adminTokenGate(request, env, 'admin/refunds')
  if (gate) return gate

  let body = null
  try {
    body = await request.json()
  } catch {
    return badRequest('请求体不是 JSON', 'bad_request')
  }
  const id = String((body && body.id) || '')
  const action = String((body && body.action) || '')
  if (!id) return badRequest('缺少申请号', 'bad_request')
  if (action !== 'done' && action !== 'rejected') return badRequest('action 只能是 done 或 rejected', 'bad_request')
  const tr = adminTraceGate(body)
  if (tr.res) return tr.res
  const { operator, note } = tr
  const wxRefundId = String((body && body.wxRefundId) || '').trim()
  if (action === 'done' && !wxRefundId) return badRequest('标 done 必须填后台给的退款回执号', 'admin_wx_refund_id_required')

  let req = null
  let order = null
  try {
    req = await getRefundRequest(env, id)
    if (!req) return json({ error: '没有这条申请', code: 'no_such_request' }, 404)
    order = await getOrderById(env, String(req.order_id))
  } catch (err) {
    console.error('[admin/refunds] read failed:', (err && err.code) || 'unknown')
    return json({ error: '暂时无法处理，请稍后再试', code: 'pro_unavailable' }, 503)
  }
  if (String(req.status) !== 'pending') {
    return json({ error: '这条申请已经是终态了', code: 'refund_not_pending' }, 409)
  }
  if (!order) return json({ error: '找不到对应的订单', code: 'no_such_order' }, 404)

  let ledgerMoved = 'none'
  try {
    if (action === 'done') {
      // 钱已退 ⇒ 权益必须在撤掉的状态。撤 0 行＝之前已撤（轮询/推送抢先），那也是我们要的终态。
      const rv = await revokeLedgerForOrder(env, String(order.id))
      ledgerMoved = rv.matched > 0 ? 'revoked' : 'already_revoked'
    } else {
      // 🔴 "还回去"只在**这一笔的撤销确实是这次申请造成的**时候做：订单还 `paid`（外部退款那一支
      //   会把订单写成 `refunded`，那笔钱真退了，绝不能还原）、且这条订单上没有**别的**生效申请。
      const others = await refundRequestsByOrders(env, [String(order.id)])
      const blocking = others.filter(
        (r) => String(r.id || '') !== id && (r.status === 'pending' || r.status === 'done'),
      )
      const externalOrRefunded = String(order.status) !== 'paid' || String(req.kind) === 'external'
      if (externalOrRefunded || blocking.length > 0) {
        ledgerMoved = 'kept_revoked'
        console.error('[admin/refunds] reject without returning coverage:', JSON.stringify({
          id, orderStatus: String(order.status), kind: String(req.kind), blocking: blocking.length,
        }))
      } else {
        const ur = await unrevokeLedgerForOrder(env, String(order.id))
        ledgerMoved = ur.matched > 0 ? 'returned' : 'nothing_to_return'
      }
    }
    const fin = await finalizeRefundRequest(env, id, { status: action, operator, note, wxRefundId })
    if (fin.matched === 0) {
      // 账本已经按方向动过了，而行没改成 ⇒ 有人抢先处理了同一条。🔴 不静默：这一条要人看一眼。
      console.error('[admin/refunds] ledger moved but row not pending anymore:', JSON.stringify({ id, action, ledgerMoved }))
      return json({ error: '这条申请刚被人处理过，请刷新后核对', code: 'refund_not_pending' }, 409)
    }
    console.log('[admin/refunds] finalized:', JSON.stringify({ id, action, ledgerMoved, kind: String(req.kind) }))
    return json({ id, status: action, ledgerMoved })
  } catch (err) {
    console.error('[admin/refunds] write failed:', JSON.stringify({ id, action, ledgerMoved, code: (err && err.code) || 'unknown' }))
    return json({ error: '暂时无法处理，请稍后再试', code: 'pro_unavailable' }, 503)
  }
}
