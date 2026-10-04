// 会员商品配置（PRD v3 3.1／E-8 已判＝**不建第四张表**，用 CF 一处模块常量）。
//
// 🔴 全仓唯一来源：`duration_days` 与价格只从这里读（3.3 上线门槛②"档位数值只能有一个来源"），
//   端上不许编译这些数字（8.1／验收 #43）。入账时 `duration_days` 写进账本当**快照** ⇒ 将来改
//   这张表不影响已入账的行（3.1 那句"查表后写入快照"的意义就在这）。
//
// ⚠️ 价格是 **D-7 占位值**（正本 3.1：「开发用占位价，开售前必须定」）：下面那两个数字
//   不许出现在任何对外页面、不许当定价依据。`goodsPrice` 是**签名的组成部分**（6.3）⇒
//   改价格必须与下单侧同一批改，否则签名与实付不一致。
//
// 🔴 测试档（`pro_test_day`，D-10 已判＝不依赖沙箱）的两条硬规矩都在本文件里落地：
//   ① 它**不进在售列表**（`onSale:false`）；② 下单要过 **openid 白名单守卫**（`testAllowed`）。
//   少了②，"便宜测试套餐"就是任何人花几分钱买一年会员的公开入口。

export const CATALOG = {
  pro_month: {
    productId: 'pro_month',
    name: 'Handle 会员 · 月卡',
    durationDays: 30,
    goodsPrice: 100, // 单位＝分（6.3 实证）；⚠️ D-7 占位
    onSale: true,
    isTest: false,
  },
  pro_year: {
    productId: 'pro_year',
    name: 'Handle 会员 · 年卡',
    durationDays: 365,
    goodsPrice: 1000, // ⚠️ D-7 占位
    onSale: true,
    isTest: false,
  },
  // 1 天、平台允许的最低价 ⇒ 用来在现网真跑一遍"下单→推送→入账→折叠→退款回收"。
  // 它是 env=0 的**真实收款单**：对账与 GMV 要单列（6.5／§十一·丙 收尾那行）。
  pro_test_day: {
    productId: 'pro_test_day',
    name: '测试道具（1 天）',
    durationDays: 1,
    goodsPrice: 1,
    onSale: false, // 🔴 不进在售列表
    isTest: true,
  },
}

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
 * 🔴 一个变量管这两件事是**实施选择**（正本 §十六 **E-13 待判**）：好处是不会出现"两个名单各改一半"，
 *    代价是发布当天必须记得**清空**名单，否则正常档只对名单内可见——方向是 fail-closed
 *    （少卖不白送），但没人盯着就会静默发生。
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
 */
export function sellableProducts(env, openid) {
  const normalVisible = canBuyNormalTier(env, openid)
  const testVisible = testAllowed(env, openid)
  return Object.values(CATALOG)
    .filter((e) => (e.onSale ? normalVisible : testVisible))
    .map((e) => ({
      productId: e.productId,
      name: e.name,
      durationDays: e.durationDays,
      goodsPrice: e.goodsPrice,
      currency: 'CNY',
      isTest: e.isTest === true,
    }))
}
