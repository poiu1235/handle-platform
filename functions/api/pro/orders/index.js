// POST /api/pro/orders —— 下单（PRD v3 4.5 前置①–⑦ ＋ 6.3 签名 ＋ 4.6 入口①）。
// GET  /api/pro/orders —— 订单页列表（4.6 的只读面 ＋ 8.2 第 11 行）。
//
// 🔴 这个端点是全文**唯一**收钱动作的入口，所以它的失败模式只能是"不卖"，不能是"卖了但判不出"：
//   任何一步判不出来（读不到 identity、读不到 pro_coverage、缺 AppKey）都当场结构化拒绝，
//   绝不"先建单再说"。⚠️ 与 7.2 那条"写入口查不到 ⇒ 放行"方向**相反**且这是刻意的：
//   那边放行的是用户改自己的数据（拦它没意义），这边放行的是"在判不出窗口的情况下收钱"（有代价）。
//
// 请求体：`{ productId, platform, code }`
//   · `productId` ＝ 端上从 `GET /api/pro/products` 里挑的那一条；🔴 金额与期限**不从端上来**，
//     由服务端用这个 id 查 `proCatalog`（6.2 铁律 3：客户端传的钱数一律不用）。
//   · `platform`   ＝ 端上上报的渠道，🔴 只落订单行做留痕／统计，不参与任何判定（4.2 那行）。
//     它与 `productId` 的渠道段**不做交叉校验**：两个值都来自同一个可伪造的端上，比了也防不住
//     故意伪装（防住的那条是 R-9 ⑬），却会误伤"上报值不在 android/ios 里"的正常设备
//     （开发者工具的 `platform` 就是 `devtools`）⇒ 这里只把它折算成 CHECK 允许的三个值之一。
//   · `code`       ＝ **现取**的一次性 `wx.login` code（一次 code2session 一次消耗）。
//
// 🔴 顺序：先换 openid（前置②）再判所有"按 openid 定"的守卫 ⇒ 整个请求里只有一个 openid 变量，
//   不会出现"守卫按 A 判、落库写 B"。代价是守卫拒绝时这一次 code 白烧了——`wx.login` 是静默的，
//   端上下一次点还能再取，不烦人。
//
// ⚠️ 本端点**不发货**：建单只是把 `pending` 行写好、把签名算出来。发货只认查单查得已付
//   （6.2 铁律 2 收紧版），实现是 `_lib/proCredit.js`，触发源是 `GET /api/pro/orders/:no`
//   （端上确认态轮询）与将来的入站推送。🔴 下单这一侧**不亲自写账本**：触发源可以有几个，
//   "写账本"的实现与入口必须各只有一份（4.6）。
//   ⇒ ✅ E-14 判乙的那条前提（"查单没代码 ⇒ 收钱认不回来"）已随 B3-3 解除：现在
//     `PRO_PURCHASE_ENABLED` 的开闸条件变成"**端上确认态轮询已上线**"，而不是"推送接收器已就绪"
//     ——轮询这条路径自己就能把货发出去（6.4 的第②层），推送只是多一层兜底。
import { json } from '../../../_lib/supabase.js'
import { serviceRoleFetch } from '../../../_lib/userAuth.js'
import { readProFlags, getAccountOpenid, getCoverageByOpenid, RENEW_WINDOW_DAYS, PROVIDER } from '../../../_lib/proCoverage.js'
import { catalogEntry, sellableProducts, testAllowed, canBuyNormalTier } from '../../../_lib/proCatalog.js'
import { findPendingOrder, closePendingOrder, markOrderAnomaly, insertOrder, listOrdersByOpenid } from '../../../_lib/proStore.js'
import { queryOrderState } from '../../../_lib/proCredit.js'
import { code2sessionKey, buildPayPayload, makeOutTradeNo, toClientPayParams } from '../../../_lib/proPaySign.js'
import { wxTicketResponse } from '../../../_lib/wxTicket.js'

const ORDER_TTL_MS = 15 * 60 * 1000 // 4.2 `expires_at`：下单时写"当前 + 15 分钟"

/**
 * 订单页（4.6 那个只读面）。三条规矩：
 * · 🔴 按 `payer_openid` 查，不按 `user_id`（4.7）；没绑微信 ⇒ 空列表（不是"全部订单"，也不是报错）。
 * · 只回白名单字段＋展示用的名字与期限；🔴 `payer_openid`／`user_id`／`attach`／`callback_raw`／
 *   `note`／`operator` 一个都不出（`proStore.listOrdersByOpenid` 的 select 列就是白名单，这里不再过滤一遍）。
 * · 购买入口关着 ⇒ `[]` 且零次数据库（与 products 同一方向；端上此时也没有页面会调它）。
 * ⚠️ 退款相关字段（`refundable`／`refund_status`／`refund_reject_reason`）**这一批没有**——
 *   D-11 的 iOS 那一支要等实测，8.2 第 11 行明写"不许当作已定"，退款申请是 B4。
 */
export async function onRequestGet(context) {
  const { env, data } = context
  const userId = data && data.user ? data.user.id : null
  if (!userId) return json({ error: '未登录' }, 401)

  const flags = readProFlags(env)
  if (!flags.purchase) return json({ purchaseEnabled: false, orders: [] })

  let openid = null
  try {
    openid = await getAccountOpenid(env, userId)
  } catch (err) {
    console.error('[pro/orders:list] openid lookup failed:', (err && err.code) || (err && err.message) || 'unknown')
    return json({ purchaseEnabled: true, orders: [] })
  }
  if (!openid) return json({ purchaseEnabled: true, orders: [] })

  let rows = []
  try {
    rows = await listOrdersByOpenid(env, openid)
  } catch (err) {
    console.error('[pro/orders:list] list failed:', (err && err.code) || (err && err.message) || 'unknown')
    return json({ error: '暂时无法读取订单，请稍后再试', code: 'pro_unavailable' }, 503)
  }
  // 商品名与期限从这里补（表里没有这两列，而"表只有一份配置来源"这条已经判过＝不建冗余列）；
  // 道具若已从表里撤下 ⇒ name 退回 id、duration 为 null，至少这单的钱看得见
  const byId = new Map(sellableProducts(env, openid).map((p) => [p.productId, p]))
  return json({
    purchaseEnabled: true,
    orders: rows.map((r) => {
      const known = catalogEntry(r.product_id)
      return {
        outTradeNo: r.out_trade_no,
        productId: r.product_id,
        name: (byId.get(r.product_id) || {}).name || (known && known.name) || r.product_id,
        goodsPrice: Number(r.goods_price),
        currency: r.currency_type,
        durationDays: known ? known.durationDays : null,
        status: r.status,
        paidAt: r.paid_at,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      }
    }),
  })
}

function unavailable(where, err) {
  // 🔴 只打码与消息，不打 openid／凭证片段（4.6 的"响应体不含 openid"要连日志一起成立）
  console.error('[pro/orders]', where, JSON.stringify({ code: (err && err.code) || null, message: (err && err.message) || null }))
  return json({ error: '暂时无法开通，请稍后再试', code: 'pro_unavailable' }, 503)
}

function isExpired(row, nowMs) {
  const t = Date.parse(String(row.expires_at || ''))
  // 读不出时刻 ⇒ 当"已过期"处理（更严的一侧：不复用一张我们自己都不确定有效期的单）
  return !Number.isFinite(t) || t <= nowMs
}

/**
 * 前置④的**复用必要条件**：同 `product_id` ＋ 同 `env` ＋ 未过期（✅ 收窄版，第二十轮评审第 6 条）。
 * 🔴 E-21 判乙之后这一句只是**必要条件**：形状对还要平台答"这张单还开着"才真复用（见调用点）。
 *   留着它而不是删掉，是因为"换档／换 env／已过期"这三种形状差已经足够让我们**不必问平台**就
 *   知道要建新单——问平台只是为了那一格"形状对但单已死"的情况（探针实测：取消后 10 秒平台就关单）。
 */
function canReuse(pending, productId, proEnv, nowMs) {
  return Boolean(pending) && String(pending.product_id) === productId && Number(pending.env) === proEnv && !isExpired(pending, nowMs)
}

export async function onRequestPost(context) {
  const { request, env, data } = context
  const userId = data && data.user ? data.user.id : null
  if (!userId) return json({ error: '未登录' }, 401) // 中间件已拦，这行是纵深

  // 前置①（第一半）：购买开关。关着 ⇒ 零次数据库、零次出网（8.3 第 1 条：只认部署变量）
  const flags = readProFlags(env)
  if (!flags.purchase) return json({ error: '暂时无法开通，请稍后再试', code: 'purchase_disabled' }, 403)

  // 🔴 缺配置必须在**任何写动作之前**响：否则会出现"单建好了、名签不出来"那种留一张死 pending 的形态。
  //   AppKey 是 secret（`wrangler pages secret put WX_PAY_APPKEY_PROD`），最容易漏配。
  if (!env.WX_PAY_OFFER_ID || !env.WX_PAY_APPKEY_PROD) {
    console.error('[pro/orders] pay config missing:', JSON.stringify({ offerId: !env.WX_PAY_OFFER_ID, appKey: !env.WX_PAY_APPKEY_PROD }))
    return json({ error: '暂时无法开通，请稍后再试', code: 'pay_config_missing' }, 503)
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return json({ error: '请求体不是合法 JSON', code: 'bad_request' }, 400)
  const productId = typeof body.productId === 'string' ? body.productId : ''
  const code = typeof body.code === 'string' ? body.code : ''
  if (!productId) return json({ error: '缺少商品', code: 'bad_request' }, 400)
  if (!code) return json({ error: '缺少微信登录凭证，请重新进入小程序后再试', code: 'no_wx_code' }, 400)

  // 商品存在性（金额／期限在此锁定；端上给的任何一个钱数都不读）
  const product = catalogEntry(productId)
  if (!product) return json({ error: '没有这个商品', code: 'product_unknown' }, 400)

  // 前置①（第二半）＋前置②：账号绑着 wechat_mp，且当场 code 换来的就是那一条
  let boundOpenid = null
  try {
    boundOpenid = await getAccountOpenid(env, userId)
  } catch (err) {
    return unavailable('identity-lookup', err)
  }
  if (!boundOpenid) {
    // 纯 Web 账号：V1 只在小程序内购买，购买锚点是 openid ⇒ 没有 openid 就没有归属
    return json({ error: '请在小程序里绑定微信后再开通', code: 'wechat_not_bound' }, 403)
  }

  const wx = await code2sessionKey(code, env)
  if (!wx.ok) return wxTicketResponse(wx) // 服务端故障 ⇒ 503；真 errcode ⇒ 400（都当场响）
  if (wx.openid !== boundOpenid) {
    // 🔴 7.5 第 10 条：这句不能一闪而过——用户的观感是"我明明在用微信买"。端上按 code 走常驻分支。
    return json(
      {
        error: '这个微信和当前账号绑定的不是同一个。请在你购买会员的那部微信里打开本小程序，或用邮箱登录后先绑定这个微信。',
        code: 'openid_mismatch',
      },
      409,
    )
  }
  const payerOpenid = wx.openid

  // 前置⑥的守卫：两道方向相反的闸门都在 openid 上判。
  //   · 测试档：恒需白名单（漏了它＝任何人猜到 productId 就能几分钱买会员，§十一·丙"这条不能省"）；
  //   · 正常档：白名单**非空**＝内测形态，名单外不可买（E-13 采纳的合成开关，6.5 上线顺序①要求发布前清空）。
  if (product.isTest) {
    if (!testAllowed(env, payerOpenid)) return json({ error: '没有这个商品', code: 'test_not_allowed' }, 403)
  } else if (!product.onSale || !canBuyNormalTier(env, payerOpenid)) {
    return json({ error: '这个商品暂时不在售', code: 'not_on_sale' }, 403)
  }

  // 前置③：注销冷静期／已提交注销 ⇒ 拒（五矩阵那行"冷静期内不冻结权益，但不收新钱"）
  try {
    const pdel = await serviceRoleFetch(env, `/rest/v1/pending_deletions?user_id=eq.${encodeURIComponent(userId)}&select=reason`)
    if (!pdel.ok) return unavailable('pending-deletions', { code: pdel.status, message: JSON.stringify(pdel.data) })
    if (Array.isArray(pdel.data) && pdel.data.length > 0) {
      return json({ error: '账号正在注销流程中，暂不可开通', code: 'deletion_pending' }, 409)
    }
  } catch (err) {
    return unavailable('pending-deletions', err)
  }

  // 前置⑤：续购窗口。判据＝`pro_coverage` 返回的那个整数（✅ E-7：null 也算可买；恰好 20 天可买），
  // 🔴 端上与这里都不许自己再减一次时间（D-18 判甲＝跨档同样拦）。
  let coverage = null
  try {
    coverage = await getCoverageByOpenid(env, payerOpenid, flags.proEnv)
  } catch (err) {
    return unavailable('coverage', err)
  }
  if (coverage.remainingDays !== null && coverage.remainingDays > RENEW_WINDOW_DAYS) {
    // D-18 配套要求①：要顺带说清"到期后可自由选档"，否则这句会被读成"到期了也不许换档"
    return json(
      {
        error: `还剩 ${coverage.remainingDays} 天，到期前 ${RENEW_WINDOW_DAYS} 天内可续购；到期后可以自由选月卡或年卡。`,
        code: 'renew_window',
        remainingDays: coverage.remainingDays,
      },
      409,
    )
  }

  const nowMs = Date.now()
  let pending = null
  try {
    pending = await findPendingOrder(env, payerOpenid)
  } catch (err) {
    return unavailable('pending-lookup', err)
  }

  // 🔴 session_key 从这里开始存在，到 buildPayPayload 用完就随函数返回一起消失：
  //   不落库、不进响应、不进日志（U-7 判 ⓐ；proPaySign.js 顶部那三条纪律）。
  //   签名**贴着这次响应算**，不提前算好放着（6.3 末段那条"静默重新登录会让签名失效"的暴露面靠这个收窄）。

  // 前置④（✅ **E-21 判乙＝复用之前必须先查单**，owner 2026-10-05）：形状对（同 `product_id`＋同 `env`
  //   ＋未过期）**并且平台答"这张单还开着"**才复用；否则查单决定"关旧建新"。
  // 🔴 为什么原来那句"形状对就复用"是坏的：探针 2026-10-05 实测——用户关掉收银台后平台约 **10 秒**
  //   就把单置 `status 6 已关闭`（`update_time − create_time = 10`），而我们在 15 分钟内仍会把那个
  //   死单号复用回去 ⇒ 第二次点"拉不起收银台"，端上只会显示"确认中"，**整个失败是静默的**。
  //   ⇒ R-9 ⑩ 由此结案：取消后的单号不可复用（官方那句"不可复用"是真的）。
  //   ⚠️ 代价照实记：凡是"名下有未付单"的点击，都要多两次出网（一次 token、一次 query_order）。
  //   省掉它的唯一办法是回到"猜"——而这里猜错的方向是"给用户一张付不了款的单"。
  //   ⚠️ 顺序仍然不能反：不查就关＝拿"我方口径的关闭"（关单接口未证＝R-9 ⑦）去赌"这单没被付"。
  if (pending) {
    const shapeMatches = canReuse(pending, productId, flags.proEnv, nowMs)
    let st = null
    try {
      st = await queryOrderState(env, pending)
    } catch (err) {
      return unavailable('pending-query', err)
    }
    if (st.outcome === 'query_error') {
      // 🔴 判不出 ⇒ **不复用、不关、也不建**（与 4.5 三态表同源：没查到不等于没付）。
      //   复用可能递出一张死单号；关掉可能压掉一张其实已付的单——两边都是拿未知当已知。
      return json({ error: '暂时无法开通，请稍后再试', code: 'pro_unavailable' }, 503)
    }
    if (st.outcome === 'paid') {
      // 上一笔其实付过了 ⇒ 不建新单，把那张单号回给端上让它去确认。
      // 🔴 入账**不在这里做**：下单端点只负责"要不要再收一笔钱"，写账本的触发源是
      //   轮询端点（与将来的推送），实现只有一份（4.6）。
      return json(
        {
          error: '你上一笔订单已经支付，权益正在生效，不需要再买一次。',
          code: 'previous_order_paid',
          orderNo: String(pending.out_trade_no),
        },
        409,
      )
    }
    if (st.outcome === 'refunded') {
      // ✅ E-17 判丙（owner 2026-10-05）：平台说这单退过了而我方从没入过账 ⇒ 标 `anomaly` 后**继续建新单**。
      // 为什么不是 409（我上一版的落地）：那张单会永远停在 pending、每次查单永远回 refunded ⇒
      //   这个人在这个微信上再也买不了任何东西，出路只剩人工进库。
      // 为什么不是 `closed`：`closed` 的语义是"没付过"，而它付过又退了——那是伪造状态列。
      // 🔴 这一步是**建新单的前置**而不是"顺手记一笔"：旧单不改掉，partial unique index
      //   （同 openid 至多一行 pending）会直接把新单挡下来 ⇒ 所以它失败时不许继续，回 503。
      //   这也不是退款状态机：不写 `refunded`、不动账本（那是 B4 的 `xpay_refund_notify`，D-22）。
      try {
        const marked = await markOrderAnomaly(env, String(pending.out_trade_no), {
          reason: 'refunded_not_credited',
          note: '主动查单回"平台已退款"而我方未入账；旧单标异常后放行新单（E-17 判丙）',
        })
        // 没改到行＝那张单在我们查它之后被别人动过（轮询刚记成 paid？）⇒ 不拦新单，但必须留一行日志：
        // 否则"我以为它被标成 anomaly 了"会变成下一次人工排障时的一条假前提。
        if (!marked.matched) console.error('[pro/orders] refunded but no row matched the anomaly PATCH:', String(pending.out_trade_no))
      } catch (err) {
        return unavailable('pending-anomaly', err)
      }
    }
    if (st.outcome === 'query_error') {
      // 判不出 ⇒ 既不关也不建（与 4.5 三态表同源：**没查到不等于没付**）
      return json({ error: '暂时无法开通，请稍后再试', code: 'pro_unavailable' }, 503)
    }
    // ✅ E-21 判乙：形状对 ＋ 平台答"这张单还开着"（status 0/1 ⇒ `via === 'unpaid'`）才复用。
    //   复用不重算金额：签的是**行里的值**（这张单成立时的价格，同时是 paySig 的输入）；
    //   但 `session_key` 可能是新的（冷启动／ensureAuth 刷新／切前台）⇒ 同一份 post_body 重签一次。
    if (shapeMatches && st.outcome === 'unpaid' && st.via === 'unpaid') {
      return await respond({ env, order: pending, sessionKey: wx.sessionKey, userId, reused: true })
    }
    // 平台答"已关闭"(6)／"查无此单"(268490002)／形状不对（换档、换 env、已过期）⇒ 关旧建新。
    // PATCH 带 `status=eq.pending`：与轮询撞上时（旧单刚被记成 paid）匹配 0 行 ⇒ 不会把已付单改回未付。
    // 🔴 `refunded` 那一支**不进这里**：上面已把旧单标成 anomaly，再关一次等于先写
    //   "这单有问题、要人看"、又写"这单没付过"——两个互相矛盾的状态。
    //   （真跑到这里也不会改到行：过滤是 status=eq.pending，而那行已是 anomaly ⇒ 匹配 0 次。
    //    但"靠上游状态恰好挡住"不是判据，所以显式跳过。）
    if (st.outcome !== 'refunded') {
      try {
        const closed = await closePendingOrder(env, String(pending.out_trade_no))
        if (!closed.matched) console.error('[pro/orders] unpaid but no row matched the close PATCH:', String(pending.out_trade_no))
      } catch (err) {
        return unavailable('pending-close', err)
      }
    }
  }

  const outTradeNo = makeOutTradeNo()
  const expiresAt = new Date(nowMs + ORDER_TTL_MS).toISOString()
  const platform = ['android', 'ios'].includes(String(body.platform)) ? String(body.platform) : 'unknown'
  const order = {
    user_id: userId, // 🔴 服务端从会话取，绝不信客户端传值（4.2）
    provider: PROVIDER,
    payer_openid: payerOpenid,
    payer_unionid: wx.unionid || null, // ✅ D-12：已绑定开放平台 ⇒ 有就落；⚠️ 覆盖率不是 100%（附录甲），永不参与判定
    platform,
    out_trade_no: outTradeNo,
    product_id: productId,
    goods_price: product.goodsPrice, // 单位＝分，来自服务端表
    currency_type: 'CNY',
    env: flags.proEnv,
    buy_quantity: 1,
    attach: userId, // 4.2：透传串，推送回来可自证这单谁下的
    status: 'pending',
    expires_at: expiresAt,
  }

  let ins = null
  try {
    ins = await insertOrder(env, order)
  } catch (err) {
    return unavailable('insert', err)
  }
  if (!ins.ok) {
    if (ins.conflict === 'pending_exists') {
      // 库侧 partial unique index 挡住了双击／并发（4.2 那行：应用层的"有则复用"挡不住两张 pending）。
      // 重读一次：现在它就是我们那张单——同商品同渠道未过期就复用它，否则如实说"稍后再试"。
      // ⚠️ 这一支**刻意不再查平台**（与上面前置④那一支不同）：能撞到这个约束，说明那张单是
      //   几毫秒前另一个请求刚建的（不是十几秒前被用户关掉的那张），此时复用是对的；
      //   而这里多查一次会让"双击"这种最常见的情形每次都翻倍出网。
      let fresh = null
      try {
        fresh = await findPendingOrder(env, payerOpenid)
      } catch (err) {
        return unavailable('pending-recheck', err)
      }
      if (canReuse(fresh, productId, flags.proEnv, nowMs)) {
        return await respond({ env, order: fresh, sessionKey: wx.sessionKey, userId, reused: true })
      }
      return json({ error: '你有一笔未完成的订单，请稍后再试', code: 'pending_order_open' }, 409)
    }
    if (ins.conflict === 'out_trade_no') {
      console.error('[pro/orders] out_trade_no collision:', outTradeNo)
      return json({ error: '暂时无法开通，请稍后再试', code: 'order_no_collision' }, 503)
    }
    return unavailable('insert-failed', { code: ins.status, message: JSON.stringify(ins.data) })
  }

  return await respond({ env, order, sessionKey: wx.sessionKey, userId, reused: false })
}

/**
 * 组装端上拉起支付需要的东西。`order` 既可能是刚组装的行，也可能是复用／重读到的既有行——
 * 🔴 两种情况都从**行里的值**签（`goods_price` 是这张单成立时的金额，同时是 paySig 的输入），
 *   不重新读价格表：改价与"存在 pending 单"的冲突属 6.5 的人工节奏（A4 那一段），
 *   不在这里静默换数——换了就会出现"库里 333、签出去 388"这种两边都对不上的形态。
 * 响应体：只有拉起参数＋单号＋展示用三样。🔴 无 openid／unionid／session_key／user_id／callback_raw（4.6）。
 */
async function respond({ env, order, sessionKey, userId, reused }) {
  const product = { productId: String(order.product_id), goodsPrice: Number(order.goods_price) }
  const outTradeNo = String(order.out_trade_no)
  const attach = order.attach == null ? String(userId) : String(order.attach)
  let payload
  try {
    payload = await buildPayPayload({ env: { WX_PAY_OFFER_ID: env.WX_PAY_OFFER_ID, WX_PAY_APPKEY_PROD: env.WX_PAY_APPKEY_PROD }, sessionKey, product, outTradeNo, attach })
  } catch (err) {
    // 走到这里说明上面那次"缺配置先响"没兜住（或行里的金额是脏数据）⇒ 结构化失败，不返回半套参数
    console.error('[pro/orders] sign failed:', String((err && err.message) || err))
    return json({ error: '暂时无法开通，请稍后再试', code: 'pay_sign_failed' }, 503)
  }
  const entry = catalogEntry(product.productId)
  return json({
    outTradeNo,
    reused,
    expiresAt: order.expires_at,
    productId: product.productId,
    goodsPrice: product.goodsPrice,
    // 确认态与订单页要展示"这张单买的是几天"；道具若已从表里撤下（下架）⇒ null，端上自己按 productId 显示
    durationDays: entry ? entry.durationDays : null,
    pay: toClientPayParams(payload),
  })
}
