// 会员三张表在 CF 侧的**唯一写模块**（PRD v3 4.6：「CF 侧写这三张表的模块只有一个」，
// 五个入口——①下单 ②支付推送 ③退款申请 ④管理端执行／补写 ⑤外部退款推送——共用它，
// 这样幂等与校验只写一遍，不会各入口漏一项）。
//
// B3-2 只落入口①要用的三件事：查未付单、置 closed、建单。②③④⑤ 到 B3-3／B4／B5 再继续
// 往本文件加；🔴 别在端点里各写一份 serviceRoleFetch 直接打这三张表（那正是 4.6 收成一个模块要防的）。
//
// ⚠️ 读回来的行是 PostgREST 的原始形状：`env`／`goods_price` 是**数字**，`expires_at` 是 ISO 串，
//   `status` 是文本。本模块不做任何"顺手转换"，转换发生在消费它的端点里——判据要能对到具体某一行。
import { serviceRoleFetch } from './userAuth.js'
import { PROVIDER } from './proCoverage.js'

const ORDERS = '/rest/v1/pro_orders'

function fail(code, status, detail) {
  const err = new Error(code)
  err.code = code
  err.status = status
  err.detail = detail
  return err
}

/**
 * 这个**付款微信**当前那张未付单（前置④读它）。
 * 🔴 键是 `payer_openid` 不是 `user_id`：权益与订单都锚在 openid 上（2.4／4.7），
 *   按账号查会在"同一微信换了账号（访客合并后）"时查不到而重复建单。
 * partial unique index `pro_orders_one_pending_per_openid` 保证同 (provider, payer_openid)
 * 至多一行 pending ⇒ `rows[0]` 就是那一张，不需要"取最新"的取舍。
 * 返回 null ＝ 没有未付单（正常路径，不是故障）；**查失败要抛**（下单收钱，判不出就不卖）。
 */
export async function findPendingOrder(env, openid) {
  const res = await serviceRoleFetch(
    env,
    `${ORDERS}?select=*&provider=eq.${PROVIDER}&payer_openid=eq.${encodeURIComponent(openid)}` +
      `&status=eq.pending&limit=1`,
  )
  if (!res.ok) throw fail('pro_order_lookup_failed', res.status, JSON.stringify(res.data))
  const rows = Array.isArray(res.data) ? res.data : []
  return rows[0] || null
}

/**
 * 订单页的读侧（4.6：🔴 行级策略拦不住列，所以订单表对 anon/authenticated 一条权限都没有，
 * 用户看自己的单只走这个 CF 只读端点）。
 * 🔴 键是 `payer_openid` 而不是 `user_id`（4.7"订单页、退款资格按付款微信看，不看账号"）——
 *   访客合并后 `user_id` 指向已删除的行，按账号查会让刚买完的人在订单页看到空列表。
 * `select` 显式列名：宁可这里少列，也不把 `callback_raw`／`payer_openid`／`note`／`operator`
 * 读进 CF 再靠"记得不返回"过滤（那是 4.6 点名的失败形态）。
 */
export async function listOrdersByOpenid(env, openid) {
  const res = await serviceRoleFetch(
    env,
    `${ORDERS}?select=out_trade_no,product_id,goods_price,currency_type,env,status,paid_at,created_at,expires_at` +
      `&provider=eq.${PROVIDER}&payer_openid=eq.${encodeURIComponent(openid)}` +
      `&order=created_at.desc&limit=50`,
  )
  if (!res.ok) throw fail('pro_order_list_failed', res.status, JSON.stringify(res.data))
  return Array.isArray(res.data) ? res.data : []
}

/**
 * 建单（落 `pro_orders` 一行 `pending`）。
 * 🔴 行由调用方组装，本模块不校验业务规则（前置①–⑦ 是端点的事）；这里只管一件事：
 *   把库侧的两种"撞号"分开回给调用方，因为它们的用户文案不同：
 *   · 撞 `pro_orders_one_pending_per_openid` ＝ 有人（可能是用户自己双击）已经建了一张未付单
 *     ⇒ 结构化 409，让端上"稍后重试／去账户页看"；
 *   · 撞 `pro_orders_out_trade_no_key` ＝ 单号随机段撞了（概率极低，但要能识别）⇒ 500 级故障。
 * 返回 `{ ok, status, conflict, data }`，`conflict` 为 null／'pending_exists'／'out_trade_no'。
 */
export async function insertOrder(env, order) {
  const res = await serviceRoleFetch(env, ORDERS, { method: 'POST', body: order })
  if (res.ok) return { ok: true, status: res.status, conflict: null, data: res.data }
  const message = String((res.data && res.data.message) || '')
  const code = String((res.data && res.data.code) || '')
  if (code === '23505' && /one_pending_per_openid/.test(message)) {
    return { ok: false, status: res.status, conflict: 'pending_exists', data: res.data }
  }
  if (code === '23505' && /out_trade_no/.test(message)) {
    return { ok: false, status: res.status, conflict: 'out_trade_no', data: res.data }
  }
  return { ok: false, status: res.status, conflict: null, data: res.data }
}
