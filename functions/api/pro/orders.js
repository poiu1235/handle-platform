// POST /api/pro/orders —— 下单（PRD v3 4.5 前置①–⑦ ＋ 6.3 签名 ＋ 4.6 入口①）。
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
// ⚠️ 本端点**不发货**：建单只是把 `pending` 行写好、把签名算出来。发货只认 `/pay/query`
//   查得已付（6.2 铁律 2 收紧版），那一路是 B3-3，且按 4.5 顶格划线——**R-9 ① 实证前不许动码**。
//   ⇒ 所以 `PRO_PURCHASE_ENABLED` 在 B3-3 落地前必须保持关（8.3 上线顺序②）。
import { json } from '../../_lib/supabase.js'
import { serviceRoleFetch } from '../../_lib/userAuth.js'
import { readProFlags, getAccountOpenid, getCoverageByOpenid, RENEW_WINDOW_DAYS, PROVIDER } from '../../_lib/proCoverage.js'
import { catalogEntry, testAllowed, canBuyNormalTier } from '../../_lib/proCatalog.js'
import { findPendingOrder, closePendingOrder, insertOrder } from '../../_lib/proStore.js'
import { code2sessionKey, buildPayPayload, makeOutTradeNo, toClientPayParams } from '../../_lib/proPaySign.js'
import { wxTicketResponse } from '../../_lib/wxTicket.js'

const ORDER_TTL_MS = 15 * 60 * 1000 // 4.2 `expires_at`：下单时写"当前 + 15 分钟"

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

/** 前置④的复用条件：同 `product_id` ＋ 同 `env` ＋ 未过期（✅ 收窄版，第二十轮评审第 6 条） */
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

  // 前置④：同 `product_id` ＋ 同 `env` ＋ 未过期 ⇒ 复用原单；换档或已过期 ⇒ 先把旧单置 `closed` 再新建。
  // 🔴 "旧单置 closed"这一步正本写的是"**先按六.4 查单确认未付**、再关、再建新"，而查单那一路（B3-3）
  //   按 R-9 ① 的划线还没动码 ⇒ 本轮先按"未证关得掉"来写：关单只是**我方口径**的关闭（R-9 ⑦），
  //   旧单在平台侧可能仍可付 ⇒ 那笔迟到付款由 4.5 的 `closed` 继续分支 ＋ `paid_after_close` 复活 ＋
  //   折叠接龙 ＋ `duplicate` 退款接住（4.5 前置④残余①，正本明写"不靠关得掉"）。
  //   ⇒ 🔴 **这条依赖链就是"B3-3 落地前不许开购买闸"的理由**：复活那一段还没代码，
  //     现在把 `PRO_PURCHASE_ENABLED` 打开＝关掉的旧单若真被付了，没人把它认回来。
  if (pending) {
    if (canReuse(pending, productId, flags.proEnv, nowMs)) {
      return await respond({ env, order: pending, sessionKey: wx.sessionKey, userId, reused: true })
    }
    try {
      await closePendingOrder(env, String(pending.out_trade_no))
    } catch (err) {
      return unavailable('pending-close', err)
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
