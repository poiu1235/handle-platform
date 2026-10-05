// 退款资格判据（PRD v3 6.1「退款资格」那一行 ＋ D-22 ＋ E-28）——**纯函数**，不读库、不碰网络。
//
// 为什么单独一份：这四条判据同时被"用户自助申请"与"订单页要不要画那颗按钮"消费，
// 而两处的读法必须一模一样（一处放宽＝额度形同不存在；一处收紧＝用户看不见能退的入口）。
// 读库留在调用方（`proStore` 是唯一写模块），这里只吃已经读回来的事实。
//
// 🔴 三条不能商量的形状：
// 1. **入口只收 `no_reason`／`duplicate`**。`manual`（客服发起）与 `external`（平台侧退款回流）
//    都不耗额度（4.2 那行），若允许端上传，就等于给用户一条"绕过每微信一次额度"的通道——
//    这不是理论风险：额度只按 `no_reason` 统计，传 `manual` 直接归零。
// 2. **撤不撤权益看的是订单行里的 `platform`（下单时落库那一个），不是这次请求传来的任何字段**。
//    E-28 判丙之后这一列第一次进入判定，而它的两个伪造方向都对我方无害（正本 4.2 那行有账）。
// 3. **窗口以"申请时刻"判**（4.2 那行：人工集中执行时可能已超平台可退期），
//    而"此刻"由调用方喂进来（服务端时间，不是设备钟——同 4.4 那条）。

export const REFUND_WINDOW_MS = 7 * 24 * 3600 * 1000
export const USER_KINDS = ['no_reason', 'duplicate']
export const ADMIN_KINDS = ['manual', 'external']

/**
 * @param {object} f 已读回来的事实：
 *   row            订单行（`status`／`env`／`paid_at`／`payer_openid`／`is_duplicate`／`platform`／`id`）
 *   payerOpenid    申请人当前绑定的 openid（4.7 的归属判据，🔴 不看 user_id）
 *   kind           申请类型
 *   nowMs          服务端此刻
 *   requestsForPayer 该 openid 名下**所有**订单的申请行（额度用）
 * @returns {{ok:true, revokeNow:boolean, orderId:string} | {ok:false, code:string, error:string}}
 */
export function evaluateRefund(f) {
  const row = f.row
  if (!row) return deny('no_such_order', '没有这笔订单，或它不属于你')
  const kind = String(f.kind || '')
  if (!USER_KINDS.includes(kind)) {
    // 4.2：`manual`／`external` 不耗额度 ⇒ 端上不许传（客服与管理端走另一条入口）
    return deny('refund_kind_not_allowed', '这一类退款不能自助发起，请联系在线客服')
  }
  if (String(row.status) !== 'paid') {
    // `refunded`＝已退过；`closed`／`pending`＝没付成功；`anomaly`＝出边只有人工（4.5 第 7 步）
    return deny('refund_not_paid', '这笔订单不在可退款的状态')
  }
  if (Number(row.env) !== 0) return deny('refund_env_mismatch', '这笔订单不在现网环境，请联系在线客服')
  if (!row.payer_openid || String(row.payer_openid) !== String(f.payerOpenid || '')) {
    // 🔴 与下单前置②同一个码、同一句话的方向：权益与退款都锚在**付款那部微信**上
    return deny('openid_mismatch', '这个微信不是购买时使用的那个。请在购买那部微信里操作，或联系在线客服。')
  }
  const paidMs = Date.parse(String(row.paid_at || ''))
  if (!Number.isFinite(paidMs)) {
    // 读不出付款时刻就判不了窗口 ⇒ 不放过（4.2 那行：`paid_at` 是 7 天窗口的起点）
    return deny('refund_no_paid_at', '读不到这笔订单的付款时刻，请联系在线客服')
  }
  if (f.nowMs - paidMs > REFUND_WINDOW_MS) {
    return deny('refund_window_closed', '已超过付款后 7 天的退款期限，这笔不能再退。')
  }
  const mine = (f.requestsForPayer || []).filter((r) => String(r.order_id) === String(row.id))
  if (mine.some((r) => r.status === 'pending' || r.status === 'done')) {
    return deny('refund_already_requested', '这笔已经申请过退款，正在处理中')
  }
  if (kind === 'duplicate' && row.is_duplicate !== true) {
    // `duplicate` 不耗额度，所以必须钉在"系统判定的并发多付"上，不能由端上自选
    return deny('refund_kind_not_applicable', '这笔不属于重复支付，请用「无理由退款」申请')
  }
  if (kind === 'no_reason') {
    // 额度按**付款微信**算（不是账号），且 `rejected` 归还（6.1 修正④）；`duplicate`/`manual` 不占
    const used = (f.requestsForPayer || []).filter(
      (r) => String(r.kind) === 'no_reason' && (r.status === 'pending' || r.status === 'done'),
    )
    if (used.length > 0) {
      return deny('refund_quota_used', '这个微信已经用过一次「无理由退款」，不能再自助申请。需要帮助请联系在线客服。')
    }
  }
  // E-28 判丙：只有下单时记为 `android` 的才"点了就撤"；`ios`／`unknown` 都**不撤**，
  // 等 `xpay_refund_notify` 回流（保守方向＝不主动拿走用户的权益）
  const revokeNow = String(row.platform) === 'android'
  return { ok: true, revokeNow, orderId: String(row.id) }
}

function deny(code, error) {
  return { ok: false, code, error }
}
