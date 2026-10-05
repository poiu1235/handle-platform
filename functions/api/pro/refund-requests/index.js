// POST /api/pro/refund-requests —— 用户自助退款申请（入口③；PRD v3 6.1、D-22、E-28）
//
// 🔴 这一支**不看** `PRO_PURCHASE_ENABLED`：购买入口关掉只意味着"不再收新钱"，
//   而"把已经收的钱退回去"是相反的方向——关着闸门就不让人退款，等于把已付费用户锁死。
//   （与 `/push/xpay` 同一条理由，两处都在注释里写死，因为最自然的错法就是"顺手复用那道闸"。）
//
// 三条顺序与理由（都写在 `_lib/proRefund.js` 那侧的判据里，这里只负责读事实与落库）：
//   ① 归属先判：`payer_openid ＝ 本账号当前绑定的微信`（4.7），🔴 不看 `user_id`；
//   ② 只有**通过全部资格判据**的申请才落行（6.1 修正一：不合格当场拒、不落库——
//      代价是"多少人试过退款"没有落点，那是已认的账，别为了统计去放宽这一条）；
//   ③ 落行在前、撤账在后：申请行是唯一能证明"这个人申请过"的东西，先拿到它再动权益。
//      撤账失败 ⇒ 回 503，申请行留着（A1 巡检看得见），用户重试会读到"正在处理中"而不是重复申请。
import { json } from '../../../_lib/supabase.js'
import { getAccountOpenid } from '../../../_lib/proCoverage.js'
import { getOrderRow, orderIdsByOpenid, refundRequestsByOrders, insertRefundRequest, revokeLedgerForOrder } from '../../../_lib/proStore.js'
import { evaluateRefund, USER_KINDS } from '../../../_lib/proRefund.js'

const STATUS_BY_CODE = {
  no_such_order: 404,
  refund_kind_not_allowed: 400,
  openid_mismatch: 403,
  wechat_not_bound: 403,
}

export async function onRequestPost(context) {
  const { request, env, data } = context
  const userId = data && data.user ? data.user.id : null
  if (!userId) return json({ error: '未登录' }, 401) // 中间件已拦，这行是纵深

  let body = null
  try {
    body = await request.json()
  } catch {
    return json({ error: '请求体不是 JSON', code: 'bad_request' }, 400)
  }
  const outTradeNo = String((body && body.outTradeNo) || '')
  const kind = String((body && body.kind) || '')
  if (!outTradeNo || !USER_KINDS.includes(kind)) {
    // 端上传不进来的 kind 在这里就挡掉（`manual`／`external` 不耗额度，是绕过额度的现成口子）
    return json({ error: '参数不完整', code: 'bad_request' }, 400)
  }

  let openid = null
  try {
    openid = await getAccountOpenid(env, userId)
  } catch (err) {
    console.error('[pro/refund] openid lookup failed:', (err && err.code) || 'unknown')
    return json({ error: '暂时无法处理退款申请，请稍后再试', code: 'pro_unavailable' }, 503)
  }
  if (!openid) {
    return json({ error: '请在小程序里绑定微信后再申请退款', code: 'wechat_not_bound' }, 403)
  }

  let row = null
  let ids = []
  let requests = []
  try {
    row = await getOrderRow(env, outTradeNo)
    ids = await orderIdsByOpenid(env, String(openid))
    requests = await refundRequestsByOrders(env, ids)
  } catch (err) {
    console.error('[pro/refund] read failed:', (err && err.code) || 'unknown')
    return json({ error: '暂时无法处理退款申请，请稍后再试', code: 'pro_unavailable' }, 503)
  }

  const verdict = evaluateRefund({
    row,
    payerOpenid: openid,
    kind,
    nowMs: Date.now(),
    requestsForPayer: requests,
  })
  if (!verdict.ok) {
    return json({ error: verdict.error, code: verdict.code }, STATUS_BY_CODE[verdict.code] || 409)
  }

  const ins = await insertRefundRequest(env, { orderId: verdict.orderId, kind })
  if (!ins.ok) {
    console.error('[pro/refund] insert failed:', JSON.stringify(ins.data))
    return json({ error: '暂时无法处理退款申请，请稍后再试', code: 'pro_unavailable' }, 503)
  }

  let revoked = false
  if (verdict.revokeNow) {
    // E-28 判丙：只有下单时记为 android 的才"点了就撤"。撤失败 ⇒ 不回滚申请行（它是唯一的凭据），
    // 只如实报"这次没成"——用户重试会读到"正在处理中"，不会重复申请，也不会白拿权益。
    try {
      const rv = await revokeLedgerForOrder(env, verdict.orderId)
      revoked = rv.matched > 0
      if (!revoked) console.error('[pro/refund] revoke matched 0 rows for an android order:', JSON.stringify({ outTradeNo }))
    } catch (err) {
      console.error('[pro/refund] revoke failed:', JSON.stringify({ outTradeNo, code: (err && err.code) || 'unknown' }))
      return json({ error: '暂时无法处理退款申请，请稍后再试', code: 'pro_unavailable' }, 503)
    }
  }
  console.log('[pro/refund] requested:', JSON.stringify({ outTradeNo, kind, revoked }))
  return json({ outTradeNo, status: 'pending', revoked })
}
