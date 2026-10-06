// GET /api/pro/orders/:no —— 单笔订单 + **每次都触发一次查单**（PRD v3 6.4 端上状态机／四层兜底第②层）。
//
// 为什么"读一个订单"要顺手查单：`success` 回调可能丢（6.2 铁律 2），而推送那一侧的接收器
// 还欠一份验签文档（R-9 里 `echostr`/sha1 那条）⇒ 现阶段"付了钱"这件事**只有主动查单能发现**。
// 端上确认态每 2s 轮一次、最多 6 次，就是这条链的用户侧节拍器。
//
// ⚠️ 四笔账（正本要求探测类代码自带）：
//   触发时机＝只在端上确认态轮询与进站补查时（本端点），不在任何列表/搜索里；
//   单次成本＝一次订单读 + （条件满足时）一次 token + 一次查单；
//   频次上限＝轮询次数（6）× 每笔订单，且 🔴 **只查 `pending` 且创建在 24 小时内**的单——
//     超 24 小时的 pending 由 6.5 的人工巡检（A4）收，不靠端上一直催；
//   凭证＝用户自己的 Bearer（只用来定位"这是他那张单"）；xpay 侧用 app 级 access_token，
//     🔴 不消耗用户的一次性 `wx.login` code、不碰 `session_key`。
//
// 🔴 归属判据是 `payer_openid ＝ 本账号当前绑定的 openid`（4.7），**不看 `user_id`**：
//   访客合并后 `user_id` 指向已删除的行，按账号查会让刚买完的人查不到自己那张单。
//   对不上时回 `no_such_order`（404）而不是 403——存在性本身也是别人的信息。
import { json } from '../../../_lib/supabase.js'
import { readProFlags, getAccountOpenid } from '../../../_lib/proCoverage.js'
import { getOrderRow, closePendingOrder, PENDING_ORDER_FRESH_MS } from '../../../_lib/proStore.js'
import { creditOrder } from '../../../_lib/proCredit.js'
import { catalogEntry } from '../../../_lib/proCatalog.js'

// 🔴 窗口只有一处定义（`proStore.PENDING_ORDER_FRESH_MS`）：这一侧用它决定"还要不要打平台"，
//   列表那一侧用同一个值决定"还要不要给人看"。两处各写一个字面量就会漂成
//   "列表里挂着一排我们早已不再追问的单"（见 `orderListVisibleTree`）。
const RECENT_MS = PENDING_ORDER_FRESH_MS

export async function onRequestGet(context) {
  const { env, params, data } = context
  const userId = data && data.user ? data.user.id : null
  if (!userId) return json({ error: '未登录' }, 401) // 中间件已拦，这行是纵深

  const outTradeNo = decodeURIComponent(String((params && params.no) || ''))
  if (!outTradeNo) return json({ error: '缺少单号', code: 'bad_request' }, 400)

  let openid = null
  try {
    openid = await getAccountOpenid(env, userId)
  } catch (err) {
    console.error('[pro/orders:get] openid lookup failed:', (err && err.code) || 'unknown')
    return json({ error: '暂时无法读取订单，请稍后再试', code: 'pro_unavailable' }, 503)
  }
  if (!openid) return json({ error: '没有这张订单', code: 'no_such_order' }, 404)

  let row = null
  try {
    row = await getOrderRow(env, outTradeNo)
  } catch (err) {
    console.error('[pro/orders:get] order read failed:', (err && err.code) || 'unknown')
    return json({ error: '暂时无法读取订单，请稍后再试', code: 'pro_unavailable' }, 503)
  }
  if (!row || String(row.payer_openid) !== String(openid)) {
    return json({ error: '没有这张订单', code: 'no_such_order' }, 404)
  }

  // 读不出 created_at ⇒ 按"不新鲜"处理（宁可少查一次，也不给一张来路不明的单反复打平台）
  const createdMs = Date.parse(String(row.created_at || ''))
  const recent = Number.isFinite(createdMs) && Date.now() - createdMs < RECENT_MS
  const flags = readProFlags(env)

  let credit = null
  let status = String(row.status)
  let paidAt = row.paid_at || null
  if (flags.purchase && status === 'pending' && recent) {
    try {
      credit = await creditOrder(env, outTradeNo)
    } catch (err) {
      // 入账事务自己已经把可判的分支变成返回值了；走到这里＝没预料到的抛错。
      // 🔴 仍然只报"未确认"，不改订单状态、也不告诉端上"失败"（6.4：报失败会让人再付一遍）
      console.error('[pro/orders:get] credit threw:', (err && err.code) || (err && err.message) || 'unknown')
      credit = { outcome: 'query_error', stage: 'credit_threw' }
    }
    if (credit.outcome === 'credited' || credit.outcome === 'already') {
      status = 'paid'
      paidAt = credit.paidAt || paidAt
    }
    // ✅ 甲′（E-41，owner 2026-10-07 判）：平台**自己**答"这张单已关闭"（status 6）⇒ 当场把这行写成 `closed`。
    //   为什么只认这一档：`closed` 的语义是"没付过"，只有平台亲口答已关闭才配得上写它。
    //   · `not_found`（查无此单）**不触发**——虚拟支付的订单是"拉起收银台那一刻"才在平台侧存在的，
    //     从没拉起的单平台本来就查不到；拿"平台没记录"冒充"平台判过死"就是伪造状态列。
    //   · `unpaid`（status 0/1 还开着）**更不能**——那张单还付得进去。
    //   买到的东西有两件：列表那一侧的隐藏依据从"我们猜的 24 小时"换成"平台说的一句话"（E-39 那条残余
    //   因此收窄，刚取消的单几秒内就不该再挂在人的眼前），以及库里少挂一天未决单（A4 的分母更准）。
    if (credit.outcome === 'closed') {
      let matched = false
      try {
        matched = (await closePendingOrder(env, outTradeNo)).matched
      } catch (err) {
        console.error('[pro/orders:get] close threw:', (err && err.code) || 'unknown')
      }
      if (matched) {
        status = 'closed'
      } else {
        // 没改到行＝有人先动了它（推送刚记成 paid／人工已收口）⇒ **重读一次再报**。
        // 🔴 绝不能库里已是 paid、这里却回端上「已取消，没有扣款」——那正是这条链上最坏的那句话
        //   （6.4：报"没扣款"会让人再付一遍）。重读失败就维持原状，最多让人多等一轮。
        try {
          const fresh = await getOrderRow(env, outTradeNo)
          if (fresh) status = String(fresh.status)
        } catch (err) {
          console.error('[pro/orders:get] re-read after losing the race:', (err && err.code) || 'unknown')
        }
      }
    }
  }

  const entry = catalogEntry(row.product_id)
  return json({
    outTradeNo: String(row.out_trade_no),
    status,
    paidAt,
    productId: String(row.product_id),
    goodsPrice: Number(row.goods_price),
    durationDays: entry ? entry.durationDays : null,
    // 🔴 只回"端上要不要继续等"用得上的两件事：这次查单得出了什么结论、入账有没有发生。
    //   不下发 payer_openid／user_id／callback_raw／note／operator（4.6）。
    credited: Boolean(credit && credit.outcome === 'credited'),
    queryOutcome: credit ? credit.outcome : status === 'pending' ? 'not_queried' : 'already_settled',
    queried: Boolean(credit),
  })
}
