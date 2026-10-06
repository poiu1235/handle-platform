// POST/GET /push/xpay —— 微信虚拟支付的入站推送接收器（PRD v3 4.5、E-20②＝开售前硬前置）。
//
// 🔴 为什么在 `functions/push/` 而不是 `functions/api/pro/`：那层 `functions/api/_middleware.js`
//   对 `/api/**` 一律要 Bearer 且**没有豁免机制**（S-3 就是为这件事立的），而微信服务器不会带我们
//   的用户态凭证——放错目录的后果不是"麻烦"，是**这条通道永远收不到东西而看起来一切正常**。
//   根目录那层 `_middleware.js` 只是全局错误边界、不做鉴权 ⇒ 这里的"公开"是刻意的，
//   第一道门由 `signature` 承担（但见 `_lib/proPush.js` 头部第 1 条：验签只决定"值不值得处理"）。
//
// 两条事件各干什么（都**不**自己下结论，事实一律回平台查单拿）：
//   · `xpay_goods_deliver_notify` ⇒ `creditOrder`（入账，账本写成后当场打发货告知）
//   · `xpay_refund_notify`        ⇒ `refundOrder`（查单确认已退 ⇒ 撤账本行 ＋ 订单 `refunded`）
// 🔴 发货那一条多了一个分支（E-40）：`no_local_order`＝平台推来一单而我们库里没有 ⇒
//   `traceUnknownOrderPush` 落一行 `anomaly`/`no_such_order` 当**地址**（没有行，`/admin/pro-anomaly`
//   连按单号处置的落点都没有），然后才谈应答码。这一支**不入账**，出边是人工。
//   ⚠️ 退款那一条的 `no_local_order` 今天仍只应答失败、不落行——那一格要不要也留取证行，等 owner 拍。
//
// ⚠️ 四笔账（探测类代码的纪律）：
//   触发时机＝平台推过来才有流量，我方零自动调用方；
//   单次成本＝一次查单（两次出网）＋入账那一路的写＋一次发货告知；没这单那一支＝一次查单＋一行写；
//   频次上限＝平台重推上限 15 次／事件，且**幂等**：`creditOrder` 撞 `pro_ledger.order_id` unique
//     回 `already`（按成功处理），`refundOrder` 第二次撤匹配 0 行 ⇒ 重推做不出双份权益、也撤不了两次；
//   凭证＝`access_token`（应用级）；🔴 不消耗用户的一次性 `code`、不碰 `session_key`。
//
// 🔴 这一支**不看** `PRO_PURCHASE_ENABLED`：入口关着只意味着"不再收新钱"，而推送到了＝钱已经进了
//   （关着就不认账＝收了钱没人认，正是 E-14 判乙那条线反过来的样子）；撤账更不能按开关关——
//   那正是今天"钱退了、权益还在"的现场。开关该管的是"画不画入口"（端上）与"接不接新单"（下单端点）。
import { creditOrder, refundOrder, traceUnknownOrderPush } from '../_lib/proCredit.js'
import { verifyPushSignature, readPushFields, pushReplyXml, excerpt, EVENT_DELIVER, EVENT_REFUND } from '../_lib/proPush.js'

const MAX_BODY = 20000 // 报文是几百字的东西；超出这个量级的不是我们要处理的推送

const xml = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
const text = (s, status = 200) =>
  new Response(s, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })

/**
 * GET：URL 校验握手。通过就**原样返回 `echostr`**——后台点「提交」那一下就是它的第一手实证。
 * 🔴 Token 没配 ⇒ 503（不是 401）：那是我方配置缺失，别让它在后台那一屏长得像"签名错了"。
 */
export async function onRequestGet(context) {
  const { request, env } = context
  const q = new URL(request.url).searchParams
  const token = env.WX_PUSH_TOKEN
  if (!token) return text('push receiver not configured', 503)
  const ok = await verifyPushSignature({
    token,
    timestamp: q.get('timestamp'),
    nonce: q.get('nonce'),
    signature: q.get('signature'),
  })
  const echostr = q.get('echostr') || ''
  console.log(`[pro-push] handshake ${ok ? 'ok' : 'rejected'} echostr_len:${echostr.length}`)
  if (!ok) return text('invalid signature', 401)
  return text(echostr) // 原样返回：不加引号、不 trim、不包 XML
}

/**
 * POST：事件分发。应答口径见 `_lib/proPush.js` 里 `pushReplyXml` 那段——
 * 🔴 "尚不可判定"必须回**非 0**，让平台按退避继续重推（四层兜底的第①层就靠这一格活着）。
 */
export async function onRequestPost(context) {
  const { request, env } = context
  const token = env.WX_PUSH_TOKEN
  if (!token) return xml(pushReplyXml({ ok: false, errmsg: 'not_configured' }), 503)

  const q = new URL(request.url).searchParams
  const raw = await request.text().catch(() => '')
  if (raw.length > MAX_BODY) {
    console.error('[pro-push] oversized body, ignored:', JSON.stringify({ len: raw.length }))
    return xml(pushReplyXml({ ok: false, errmsg: 'too_large' }))
  }

  const signed = await verifyPushSignature({
    token,
    timestamp: q.get('timestamp'),
    nonce: q.get('nonce'),
    signature: q.get('signature'),
  })
  if (!signed) {
    // 🔴 E-25：不写库（正本 4.5 三态表第三行原写"记 sign_invalid"，理由见 _lib/proPush.js 头部第 2 条）
    console.error('[pro-push] signature rejected, nothing written:', JSON.stringify({ excerpt: excerpt(raw, 200) }))
    return xml(pushReplyXml({ ok: false, errmsg: 'invalid_signature' }))
  }

  const f = readPushFields(raw)
  if (!f.outTradeNo) {
    // 验签过了却没有单号＝字段名与我们读的不一样 ⇒ 把原文打出来，这一次日志就是取证
    console.error('[pro-push] no out_trade_no in a signed push:', JSON.stringify({ event: f.event, excerpt: excerpt(raw) }))
    return xml(pushReplyXml({ ok: false, errmsg: 'no_order_no' }))
  }

  if (f.event === EVENT_DELIVER) {
    const r = await creditOrder(env, f.outTradeNo)
    // 🔴 `no_local_order` 单独立一支（✅ E-40；正本 4.5 第 2 步那句「未命中 ⇒ 落一行 anomaly…
    //   不能只写日志」今天第一次落到码上）。原来这一支跟着"应答失败"走 ⇒ 平台重推 15 次耗尽后
    //   库里零痕迹，而 `/admin/pro-anomaly` 是按 `out_trade_no` 取行的——**没有行就没有出边**。
    //   现在：落成落点 ⇒ 应答成功（停推，出边交人工）；没落成／那一行其实存在 ⇒ 应答失败保留重推。
    if (r.outcome === 'no_local_order') {
      let t = { outcome: 'refused', reason: 'trace_threw' }
      try {
        t = await traceUnknownOrderPush(env, f)
      } catch (err) {
        console.error('[pro-push] trace threw:', JSON.stringify({ code: (err && err.code) || 'unknown' }))
      }
      const traced = t.outcome === 'traced'
      // ✅ E-41（owner 判＝丙）：撞 `out_trade_no` unique ＝ **那一行其实存在**（我们读的时候没有、插的时候有了
      //   ⇒ 下单那次写入比推送晚落地）。有行就有入账可能，所以**就地再判一次**，而不是把结论推给"下一次重推"——
      //   "重推会自己补"这句在 2026-10-05 真机已被降级过（三条失败的退款推送一条都没再来）。
      //   幂等由 `pro_ledger.order_id` 那条 unique 兜着：重跑一次做不出双份权益，`already` 按成功处理。
      if (t.outcome === 'exists') {
        let again = { outcome: 'query_error', stage: 'retry_threw' }
        try {
          again = await creditOrder(env, f.outTradeNo)
        } catch (err) {
          console.error('[pro-push] retry after conflict threw:', JSON.stringify({ code: (err && err.code) || 'unknown' }))
        }
        const credited = again.outcome === 'credited' || again.outcome === 'already'
        console.error('[pro-push] deliver raced with our own insert:', JSON.stringify({ outTradeNo: f.outTradeNo, trace: t.outcome, retry: again.outcome, replied: credited ? 0 : 1 }))
        return xml(pushReplyXml({ ok: credited }))
      }
      // 🔴 error 级：每一次都是"钱可能进了平台而我们连单都没有"，不是常规流量（tail 里要跳出来）
      console.error('[pro-push] deliver without a local order:', JSON.stringify({ outTradeNo: f.outTradeNo, trace: t.outcome, reason: t.reason || null, queryOutcome: t.queryOutcome || null, replied: traced ? 0 : 1 }))
      return xml(pushReplyXml({ ok: traced }))
    }
    const ok = r.outcome === 'credited' || r.outcome === 'already'
    // 🔴 未付／查无／判不出 ⇒ 应答失败（不入账也不停推，订单维持 pending）：4.5 那张三态表第 2 行
    console.log('[pro-push] deliver:', JSON.stringify({ outTradeNo: f.outTradeNo, outcome: r.outcome, stage: r.stage || null, replied: ok ? 0 : 1 }))
    return xml(pushReplyXml({ ok }))
  }

  if (f.event === EVENT_REFUND) {
    const r = await refundOrder(env, f.outTradeNo, { pushOpenid: f.openid, refundId: f.refundId })
    // `refunded_not_credited` 回 0：钱退了而我们从没发过权益，这是一件**已判定**的事实，
    // 没有"再问一次就能变清楚"的余地 ⇒ 停推，那张 anomaly／pending 行由 A3 巡检接手
    // 🔴 `openid_mismatch` 回**非 0**：这条消息与该账号无关＝不撤，但也不许我们把它读成"处理完了"——
    //   重推会一直失败到上限，而 A3/A4 之外还有一条日志能查，比静默停推好。
    const ok = ['refunded_revoked', 'already_refunded', 'refunded_not_credited', 'credited', 'already'].includes(r.outcome)
    console.log('[pro-push] refund:', JSON.stringify({ outTradeNo: f.outTradeNo, outcome: r.outcome, stage: r.stage || null, revokedRows: r.revokedRows === undefined ? null : r.revokedRows, refundFee: f.refundFee, replied: ok ? 0 : 1 }))
    return xml(pushReplyXml({ ok }))
  }

  // 认不出的事件名：应答失败让平台重推，同时把原文留下——`xpay_goods_deliver_notify` 这个名字
  // 只有工程稿给过（正本 R-9 ⑥），真推来的是别的写法时这一行日志就是唯一的发现机会。
  console.error('[pro-push] unknown event:', JSON.stringify({ event: f.event, msgType: f.msgType, outTradeNo: f.outTradeNo, excerpt: excerpt(raw) }))
  return xml(pushReplyXml({ ok: false, errmsg: 'unhandled_event' }))
}
