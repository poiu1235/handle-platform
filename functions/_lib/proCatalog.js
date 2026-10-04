// 会员商品配置（PRD v3 3.1／E-8 已判＝不建第四张表，用 CF 一处模块常量）。
//
// 🔴 全仓唯一来源：`duration_days` 与价格只从这里读（3.3 上线门槛②"档位数值只能有一个来源"），
//   端上不许编译这些数字（8.1／验收 #43）。入账时 `duration_days` 写进账本当**快照** ⇒ 将来改
//   这张表不影响已入账的行。
//
// ✅ 2026-10-04 owner 在后台把道具**发布**了，五个 id 就是这张表的形状（截图：开发版本／已发布）：
//     monthly_mem_android 333 · monthly_mem_apple 388 · yearly_mem_android 4990 · yearly_mem_apple 5990
//     monthly_test 1（测试道具）
//   ⇒ 这等于把 **D-21 判成"分渠道"**（正本原来只有 `pro_month`／`pro_year` 两档）。
//
// 🔴 两条随之而来的硬规矩：
// 1. **端上只能选"档位"，不能选价格**。`goodsPrice` 永远从这里取（6.2 铁律 3）；端上上报的
//    `platform` 是可伪造字段（4.2 明写不许进入任何判定），所以它在这里的作用**只是挑一个商品**，
//    不构成"权益判定"。残余风险写在 `productFor` 的注释里，不藏。
// 2. `productId` 与 `goodsPrice` 都是 **paySig 的组成部分** ⇒ 这张表与后台必须逐字一致；
//    不一致的症状是"拉起支付被平台直接拒绝"，看起来像平台故障。改价要走后台 + 这里同一批。
//
// ✅ 价格单位（R-9 ⑰ 已结案，2026-10-04 owner 确认）：**后台那一列填的是「元」，程序里传的是「分」**
//    ⇒ 后台显示 3.33／49.9／3.88／59.9／0.01，本表写 333／4990／388／5990／1。
//    两边不一致时表现不是"价格不对"，而是 `goodsPrice` 参与 `paySig` ⇒ 拉起支付被平台直接拒。
// ✅ 五个道具都已发布到**线上版本**（截图：线上版本／发布时间 2026-10-4）。

export const PLATFORMS = ['android', 'ios']

/** 档位（期限）与渠道价目分开定义：期限是商品语义，价格是渠道差异 */
const TIERS = {
  monthly: { tier: 'monthly', name: 'Handle 会员 · 月卡', durationDays: 30, isTest: false, prices: { android: 333, ios: 388 } },
  yearly: { tier: 'yearly', name: 'Handle 会员 · 年卡', durationDays: 365, isTest: false, prices: { android: 4990, ios: 5990 } },
  // 测试道具：owner 2026-10-04 把后台文案改成「1天测试卡」⇒ 期限 **1 天**（回到正本 D-10 的原设计），
  // id 仍是 `monthly_test`（改 id 要重新发布道具，改文案不用）。价格 1 分＝后台显示的 0.01 元。
  // 它走完全正常的链路（下单→推送→入账→折叠→manual 退款回收），所以不破 7.6 铁律；
  // 但它是 env=0 的**真实收款单** ⇒ 对账与 GMV 要单列（6.5／§十一·丙）。
  monthly_test: { tier: 'monthly_test', name: '测试道具（1 天）', durationDays: 1, isTest: true, prices: { android: 1, ios: 1 } },
}

/** 后台的道具 id 命名：测试道具不按渠道分（一个 id 两端都用） */
function productIdFor(tierKey, platform) {
  const t = TIERS[tierKey]
  if (!t) return null
  if (t.isTest) return 'monthly_test'
  return `${tierKey}_mem_${platform === 'ios' ? 'apple' : 'android'}`
}

function buildCatalog() {
  const out = {}
  for (const [tierKey, t] of Object.entries(TIERS)) {
    for (const platform of t.isTest ? ['android'] : PLATFORMS) {
      const productId = productIdFor(tierKey, platform)
      out[productId] = {
        productId,
        tier: tierKey,
        platform: t.isTest ? null : platform,
        name: t.name,
        durationDays: t.durationDays,
        goodsPrice: t.prices[platform],
        currency: 'CNY',
        onSale: !t.isTest,
        isTest: t.isTest === true,
      }
    }
  }
  return out
}

export const CATALOG = buildCatalog()

export function catalogEntry(productId) {
  const e = CATALOG[String(productId)]
  return e || null
}

/** 按 `product_id` 查期限快照（4.5 入账第 5 步用）。查不到 ⇒ null，调用方**不许**入账 */
export function durationDaysFor(productId) {
  const e = catalogEntry(productId)
  return e ? e.durationDays : null
}

/**
 * 这个档位在这个渠道上对应哪个道具。🔴 返回 null 的两种情况调用方都必须**拒单**：
 *   · 档位不存在（拼错／已下架）；
 *   · 渠道不是 `android`／`ios`（端上没上报或上报了别的）——宁可拒，不许"默认按安卓价"，
 *     那等于把渠道差价变成一个可以靠"不填"拿到的折扣。
 * ⚠️ 已知残余（D-21 判分渠道的代价，owner 认领）：`platform` 由端上上报、可伪造 ⇒ 理论上
 *    iOS 用户可以声明 android 少付 0.55／10.00 元。它**不换来任何权益**（折叠只认 duration_days），
 *    损失是差价而不是白拿会员。若平台侧对"道具与真实渠道"另做校验，伪装的表现是下单被拒——
 *    这一条属 R-9 待证（第 ⑬ 项），实测后回来把这段改成事实。
 */
export function productFor(tierKey, platform) {
  if (typeof platform !== 'string' || !PLATFORMS.includes(platform)) return null
  const productId = productIdFor(String(tierKey), platform)
  return productId ? catalogEntry(productId) : null
}

/**
 * 测试白名单（wrangler `[vars]` 的 `PRO_TEST_OPENIDS`，逗号分隔）。
 * 🔴 缺失／空串 ⇒ **空集合**，不是"不限制"：测试档在名单为空时对任何人都不可用（fail-closed）。
 */
export function testWhitelist(env) {
  return String(env.PRO_TEST_OPENIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** 这个 openid 能不能买测试档 */
export function testAllowed(env, openid) {
  if (typeof openid !== 'string' || openid === '') return false
  return testWhitelist(env).includes(openid)
}

/**
 * 内测期那道闸（8.3 末段那句"对外同批、内测期分步"）：**名单非空＝内测形态**，
 * 正常档也只对名单内的人出现在列表里；名单为空＝发布形态，正常档全量可见。
 * ⚠️ 它只管"看不看得到／买不买得了正常档"，测试档那条 `testAllowed` 永远单独判——
 *    两者方向相反（一个是"名单非空就收紧"，一个是"名单为空就全拒"），别互相替代。
 * 🔴 一个变量管这两件事是**已采纳的实施选择**（正本 §十六 E-13）：好处是不会出现"两个名单各改一半"，
 *    代价是发布当天必须记得**清空**名单，否则正常档只对名单内可见——方向是 fail-closed
 *    （少卖不白送），但没人盯着就会静默发生，所以它同时进了 6.5 的上线顺序①。
 */
export function purchaseWhitelistActive(env) {
  return testWhitelist(env).length > 0
}

export function canBuyNormalTier(env, openid) {
  if (!purchaseWhitelistActive(env)) return true
  if (typeof openid !== 'string' || openid === '') return false
  return testWhitelist(env).includes(openid)
}

/**
 * 在售列表的内容。**只给展示用**：下单侧必须自己再查一次 `catalogEntry` 与守卫，
 * 不许拿"它出现在列表里"当判据（列表可以被缓存，守卫不能）。
 * 列表按**档位**给（一个档位带两个渠道价），端上只需要知道自己渠道对应的那一条——
 * 这样"选品"这个动作留在服务端，端上拿不到"换 id 就换价"的空间。
 */
export function sellableProducts(env, openid) {
  const normalVisible = canBuyNormalTier(env, openid)
  const testVisible = testAllowed(env, openid)
  return Object.values(CATALOG)
    .filter((e) => (e.onSale ? normalVisible : testVisible))
    .map((e) => ({
      productId: e.productId,
      tier: e.tier,
      platform: e.platform,
      name: e.name,
      durationDays: e.durationDays,
      goodsPrice: e.goodsPrice,
      currency: e.currency,
      isTest: e.isTest === true,
    }))
}
