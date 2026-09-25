// 余额写入字段的**唯一正本**（S2-M7：BQ3 拍 (α)、BQ15 拍「trim 进 CF」、BQ16 拍「三条写路径共用」、
// BQ17 拍「金额上界 1000000」，均为 2026-09-25 产品裁定）。
//
// 为什么存在：`balances` 整表**一条 CHECK 都没有**（2026-09-25 现网实测，见
// handle-miniprogram/doc/miniprogram-ai-s2-balance-prd.md 2.9.2），而三条写路径
// （单条 `POST /api/balances`、`PATCH /api/balances/[id]`、批量 `POST /api/balances/import`）
// 此前全部原样透传 ⇒ "库里干净"只靠小程序 / Web / 导入三个客户端各自自觉。本模块把它换成后端保证。
//
// ⚠ 纪律（SD3）：规则**只住这一个文件**，三条路由都从这里取，谁也不许自带一份。
//   各客户端原有的 `trim()` / `Number()` 留着是为了**读的时候匹配得上**与输入体验，
//   不再承担"写进去干净"的责任 ⇒ 改规则只改这里，三条路径自动同步，不存在双份漂移。
// ⚠ 拍板时写死的边界：**只做校验 + 字段白名单**。不加 DDL CHECK（BQ14，已拍"先不做、先记上"）、
//   不改返回结构、不动鉴权层、**不替客户端补 `updated_at` 时钟**（2.4 的逐键语义是既有行为）。

/** BQ6-4：名称上限 50 字。现网最长 8 字 ⇒ 与存量零冲突；这是 balances 新立惯例（cards 卡名无上限） */
export const APP_NAME_MAX = 50

/** BQ17：金额上界 100 万。**数值由产品裁定，不是实现层发明的**（现网 max 10086，百倍余量） */
export const AMOUNT_MAX = 1000000

/**
 * 金额归一 + 校验（BQ6-3 拒负 / BQ6-5 无歧义抽数 / BQ17 上界）。
 * 收：number，以及**无歧义**的字符串写法 `"100元"` `"￥100"` `"1,200"` `"12.5"`。
 * 拒：含糊量词（`"八十多"`、`"1千"`）、非十进制字面量（`"1e5"`）、负数、超上界、非有限值。
 */
export function parseAmount(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { error: '金额需为有限数值' }
    if (raw < 0) return { error: '金额不能为负数' }
    if (raw > AMOUNT_MAX) return { error: `金额超出上限 ${AMOUNT_MAX}` }
    return { value: raw }
  }
  if (typeof raw !== 'string') return { error: '金额需为数值' }

  const cleaned = raw
    .trim()
    .replace(/[¥￥$]/g, '')
    .replace(/(元|块|圆|钱)$/, '')
    .replace(/,/g, '')
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(cleaned)) {
    return { error: `金额无法识别：${raw}（请给一个准确数字）` }
  }
  const value = Number(cleaned)
  if (!Number.isFinite(value)) return { error: '金额超出可表示范围' }
  if (value < 0) return { error: '金额不能为负数' }
  if (value > AMOUNT_MAX) return { error: `金额超出上限 ${AMOUNT_MAX}` }
  return { value }
}

/**
 * 名称校验（BQ15 + BQ6-4）。
 * 只 trim **首尾**：**不折叠内部空白**（「肯德基 外卖」是合法名字）、**不做大小写折叠**——
 * 与三个客户端既有的 `name.trim()` 逐字同构，所以"自觉 → 后端保证"这个换层过程里，
 * 现存数据能达到的形态一条都没变（实测：首尾空白 0 条、内部空格 0 条）。
 * ⚠ JS 的 `trim()` 会去掉全角空格，而 PG 的 `btrim()` 默认只去 ASCII 空格。这个不对称属
 *   DDL CHECK 那半步（BQ14）的议题，其前置条件已写在那条里（真加 CHECK 须照 `cards.sql:36-40`
 *   的 ASCII-only 形制）。**这里不提前替它做对齐** —— 折叠全角空格会偏离既有客户端行为。
 */
export function parseAppName(raw) {
  if (typeof raw !== 'string') return { error: 'app_name 需为字符串' }
  const value = raw.trim()
  if (!value) return { error: '名称不能为空' }
  if (value.length > APP_NAME_MAX) return { error: `名称过长（上限 ${APP_NAME_MAX} 字）` }
  return { value }
}

/** 图标：null = 未配置（既有形态，手工新增也落 null，占现网 8/31）；空串不是合法值，清空请传 null。 */
export function parseIconKey(raw) {
  if (raw === null) return { value: null }
  if (typeof raw !== 'string') return { error: 'icon_key 需为字符串或 null' }
  const value = raw.trim()
  if (!value) return { error: 'icon_key 不能为空字符串（清空请传 null）' }
  if (value.length > 64) return { error: 'icon_key 过长' }
  return { value }
}

// `updated_at` 由客户端提供（2.4）。只验类型、不验语义，也刻意不替它补时钟：
// 「省略 ⇒ 覆盖行保留旧值 / 新行走列默认值」是既有契约，AI 链路靠 BD5 显式带值来满足，
// 而不是靠服务端悄悄填一个 —— 那会把"skill 少带字段"这个 bug 表现成"看起来正常"。
function parseUpdatedAt(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'updated_at 需为非空字符串' }
  if (Number.isNaN(Date.parse(raw))) return { error: 'updated_at 不是可解析的时间' }
  return { value: raw }
}

/**
 * 单条新增 / 同名覆盖（POST）的载荷。返回 `{ error }` 或 `{ row }`。
 * `row` 是**白名单后的对象** ⇒ payload 里任何别的键都到不了 PostgREST。
 * `icon_key` 保持 `|| null` 的原语义（永远进 body ⇒ 省略即清空；2.3/2.4 那条逐键差异是既有行为，
 * 本模块只加校验、不改它 —— 改它属另一项未拍板的后端变更）。
 * `userId` 必须由调用方从**已验签的 token** 传入，不接受客户端自带的 user_id。
 */
export function buildBalanceInsert(payload, userId) {
  const name = parseAppName(payload.app_name)
  if (name.error) return { error: name.error }

  if (payload.amount === undefined || payload.amount === null) return { error: '缺少金额' }
  const amount = parseAmount(payload.amount)
  if (amount.error) return { error: amount.error }

  const icon = parseIconKey(payload.icon_key === undefined ? null : payload.icon_key)
  if (icon.error) return { error: icon.error }

  const row = {
    app_name: name.value,
    amount: amount.value,
    icon_key: icon.value,
    user_id: userId,
  }
  if (payload.updated_at !== undefined) {
    const t = parseUpdatedAt(payload.updated_at)
    if (t.error) return { error: t.error }
    row.updated_at = t.value
  }
  return { row }
}

/**
 * 修改（PATCH）。**只校验并保留 payload 里出现过的键** ⇒ 部分更新语义一字不动
 * （端上"清零"就只发 `{amount, updated_at}`，不能要求它带全四个键）。
 * 白名单效果：`id` 与 `user_id` 永远不会从这里出去 ⇒ 客户端无法通过 PATCH 改归属
 * （此前靠 RLS 报 42501 兜底，现在在本层给出可读的中文拒绝）。
 */
export function buildBalancePatch(payload) {
  const row = {}
  if (payload.app_name !== undefined) {
    const name = parseAppName(payload.app_name)
    if (name.error) return { error: name.error }
    row.app_name = name.value
  }
  if (payload.amount !== undefined) {
    const amount = parseAmount(payload.amount)
    if (amount.error) return { error: amount.error }
    row.amount = amount.value
  }
  if (payload.icon_key !== undefined) {
    const icon = parseIconKey(payload.icon_key)
    if (icon.error) return { error: icon.error }
    row.icon_key = icon.value
  }
  if (payload.updated_at !== undefined) {
    const t = parseUpdatedAt(payload.updated_at)
    if (t.error) return { error: t.error }
    row.updated_at = t.value
  }
  if (Object.keys(row).length === 0) return { error: '没有可更新的字段' }
  return { row }
}
