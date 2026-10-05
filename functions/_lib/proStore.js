// 会员三张表在 CF 侧的**唯一写模块**（PRD v3 4.6：「CF 侧写这三张表的模块只有一个」，
// 五个入口——①下单 ②支付推送 ③退款申请 ④管理端执行／补写 ⑤外部退款推送——共用它，
// 这样幂等与校验只写一遍，不会各入口漏一项）。
//
// B3-2 落了入口①要用的三件事（查未付单、置 closed、建单）＋订单页读侧；B3-3 又加了入账那四件
// （读单行、回填 paid、查账本在不在、写账本行）。③④⑤ 到 B4／B5 再继续往本文件加；
// 🔴 别在端点里各写一份 serviceRoleFetch 直接打这三张表（那正是 4.6 收成一个模块要防的）。
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
 * `select` 显式列名：纪律落在**回给端上的那些键**上（4.6 点名的失败形态是"读进 CF 再靠记得不返回"），
 * 而判定要用的列必须读得到——`payer_openid` 两条读路都要（`getOrderRow` 一直是这么读的，
 * 这一条原来漏了 ⇒ 同族两个函数形状不一致，正是订单页那颗按钮不出现的原因，见函数体里那段）。
 * 🔴 真正一律不许读进来的是 `callback_raw`／`note`／`operator`／`attach`：那些不是判定输入。
 */
export async function listOrdersByOpenid(env, openid) {
  const res = await serviceRoleFetch(
    env,
    // 🔴 读回来的列比**回给端上的**多：`id`（join 申请行）、`platform`＋`is_duplicate`＋`payer_openid`
    //   都是退款资格判据的输入（E-28 之后 `platform` 第一次进入判定）。
    //   ⚠️ 2026-10-05 真机踩过：这一列原来漏了 `payer_openid` ⇒ `evaluateRefund` 里那句
    //   `String(row.payer_openid) !== String(f.payerOpenid)` 恒成立 ⇒ 每行都判成 `openid_mismatch`
    //   ⇒ 订单页那颗「申请退款」按钮**永远不出现**。离线判据抓不到，因为打桩喂的行是手写的、带着这一列。
    //   ⇒ 判据挪到对得上的那一层：`test:orders` 10.4b 静态要求"资格函数读的每个 `row.X` 必须在这条 select 里"，
    //   10.4 只钉**响应体**的键白名单（白名单从来都是响应侧的事）。
    //   ⚠️ 读 `payer_openid` 不构成外泄：它就是本次查询的过滤值（由调用方自己的 identity 换来），
    //   而响应侧仍然一个字都不回（10.4／10.5）。真正不许读进来的是 `callback_raw`／`note`／`operator`／`attach`。
    `${ORDERS}?select=id,out_trade_no,product_id,goods_price,currency_type,env,status,paid_at,created_at,expires_at,platform,is_duplicate,payer_openid` +
      `&provider=eq.${PROVIDER}&payer_openid=eq.${encodeURIComponent(openid)}` +
      `&order=created_at.desc&limit=50`,
  )
  if (!res.ok) throw fail('pro_order_list_failed', res.status, JSON.stringify(res.data))
  return Array.isArray(res.data) ? res.data : []
}

/**
 * 建单（落 `pro_orders` 一行 `pending`）。 * 🔴 行由调用方组装，本模块不校验业务规则（前置①–⑦ 是端点的事）；这里只管一件事：
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

/**
 * 入账第 5 步的前半：回填 `paid_at`／`wx_order_id` 并把订单置 `paid`。
 * 🔴 过滤条件 `status=in.(pending,closed)`（🔴 值不加引号，理由见下面那句注释）：已
 *   `paid`/`refunded` 的行改不动——这正是 4.5 第 3 步"拒绝复活"的库侧形态（重放不会把
 *   已付单的 `paid_at` 挪后，而那是 7 天窗口起点）。
 *   匹配 0 行**是错误**：🔴 本函数要求 PostgREST 把改到的行回回来（`Prefer: return=representation`），
 *   空数组就抛 `pro_order_mark_paid_no_row`。理由不是洁癖——2026-10-05 真机第一轮出现"账本行写成了、
 *   订单却还是 pending"的形状，而旧写法下 PATCH 改 0 行与改 1 行回的都是 `200 + 空 body`，
 *   代码根本分不开这两种情况。双入账的闸门仍是 `pro_ledger.order_id` unique，但**状态没改成
 *   就必须停**：账本行排在后面，抛在这里等于"要么两边都动、两边都不动"。
 * ⚠️ `paidAtIso` 由调用方给（查单 `paid_time × 1000`；拿不到才退到"本次确认时刻"并留 `note`），
 *   🔴 绝不取落库时刻。
 * ⚠️ `isDuplicate`／`paidAfterClose` 只在为真时写：这两列的默认值就是 false，而它们是
 *   4.2 点名"不落字段就统计不到"的那两个位——`is_duplicate` 决定 B4 里这单算不算
 *   duplicate 类（不耗退款额度），`paid_after_close` 是"我方已关单后钱才回来"的唯一体现。
 * ⚠️ `wxOrderId`／`wxpayOrderId` 是两个**不同的东西**（E-22＋E-23，都由一手回包读出来）：前者＝平台侧
 *   订单号（`VPO…`，**未付的单上就有**）、后者＝微信支付交易单号（`4500…`，付款之后才有，与后台
 *   「交易订单」那一列"交易单号"同源）。🔴 别互相赋值；也**别给后者加唯一约束**——回填撞唯一会让
 *   这笔 PATCH 抛错，按 4.5 的形状就是"账本也不写"＝一笔已付的钱入不了账（见 `pro-billing-e23-migration.sql` 文件头）。
 */
export async function markOrderPaid(env, { outTradeNo, paidAtIso, wxOrderId, wxpayOrderId, note, isDuplicate, paidAfterClose }) {
  const body = { status: 'paid', paid_at: paidAtIso, updated_at: new Date().toISOString() }
  if (wxOrderId) body.wx_order_id = String(wxOrderId)
  if (wxpayOrderId) body.wxpay_order_id = String(wxpayOrderId)
  if (note) body.note = String(note)
  if (isDuplicate) body.is_duplicate = true
  if (paidAfterClose) body.paid_after_close = true
  const res = await serviceRoleFetch(
    env,
    // 🔴 值列表**不加引号**：PostgREST 的 `in.()` 走 CSV 解析，官方示例是 `genre=in.(drama,comedy)`。
    //   原来这里写的是 `in.('pending','closed')`，2026-10-05 真机第一轮实测**匹配 0 行**
    //   （账本行写进去了、订单还是 pending，见正本 §十六 E-19）。单引号到底是被当成值的一部分
    //   还是别的机制，我**没有一手文档证据**（postgrest.org 当时抓不下来）⇒ 不当已证根因写。
    //   成立的是两件事：① 这个写法在他库上确实匹配不到行（同一张表、同一个 `eq` 条件的 SELECT 找得到行）；
    //   ② 改成 CSV 形态后如果还匹配 0 行，下面那道 representation 判据会**直接抛**，不会再静默。
    `${ORDERS}?out_trade_no=eq.${encodeURIComponent(outTradeNo)}&status=in.%28pending%2Cclosed%29`,
    { method: 'PATCH', body, prefer: 'return=representation' },
  )
  if (!res.ok) throw fail('pro_order_mark_paid_failed', res.status, JSON.stringify(res.data))
  const rows = Array.isArray(res.data) ? res.data : null
  if (rows === null) throw fail('pro_order_mark_paid_unreadable', res.status, 'PATCH 没回 representation（Prefer 被吞？）')
  if (rows.length === 0) throw fail('pro_order_mark_paid_no_row', res.status, `WHERE 没匹配到行：${outTradeNo}`)
  return rows[0]
}

/**
 * 这张单是否已入账（幂等判据的**可读版**，用于给端上/日志一个好文案）。
 * 🔴 它不是闸门——读与写之间有并发窗口，真正的闸门是 `pro_ledger.order_id` 那条 unique，
 *   见 `insertLedgerRow` 的 `already_credited` 分支。别拿这个返回值当"可以放心插"的依据。
 */
export async function ledgerExistsForOrder(env, orderId) {
  const res = await serviceRoleFetch(env, `/rest/v1/pro_ledger?select=id&order_id=eq.${encodeURIComponent(orderId)}&limit=1`)
  if (!res.ok) throw fail('pro_ledger_lookup_failed', res.status, JSON.stringify(res.data))
  return Array.isArray(res.data) && res.data.length > 0
}

/**
 * 入账第 5 步的后半：写一行账本（权益的唯一来源）。
 * 🔴 双入账的闸门是库侧 `pro_ledger_order_id_uk`：`ledgerExistsForOrder` 说没有也可能插失败。
 *   所以 23505 单独回成 `conflict:'already_credited'`，调用方**必须按幂等成功处理**——
 *   报 500 会让用户以为"付了钱没到账"而再买一次，那才是这条路径真正的伤害。
 * ⚠️ `duration_days` 是快照：由调用方从 `proCatalog` 查出来传进来，本模块不查表。
 * 🔴 `order_id`／`payer_openid`／`effective_at`／`duration_days` 缺任一个就**当场抛**，不发给库。
 *   理由是 2026-10-05 那次实读：账本行的 `order_id` 是可空的（unique 在 Postgres 里允许任意多行
 *   null），所以"漏写"这一类失误**库侧约束抓不住**，漏了以后表现为——去重闸门失效、退款撤不回
 *   （B4 按 order_id 找行）、对账口径把它算成真单。三张表里只有这一列是"漏写比写错更贵"的形状，
 *   所以闸门写在本模块的入口，而不是指望每个调用方都记得（四个调用方：轮询、推送、补写、夹具）。
 */
export async function insertLedgerRow(env, row) {
  for (const key of ['order_id', 'payer_openid', 'effective_at', 'duration_days']) {
    if (row[key] === null || row[key] === undefined || row[key] === '') {
      throw fail('pro_ledger_row_incomplete', 500, key)
    }
  }
  const res = await serviceRoleFetch(env, '/rest/v1/pro_ledger', { method: 'POST', body: row })
  if (res.ok) return { ok: true, status: res.status, conflict: null, data: res.data }
  const message = String((res.data && res.data.message) || '')
  const code = String((res.data && res.data.code) || '')
  if (code === '23505' && /order_id/.test(message)) {
    return { ok: false, status: res.status, conflict: 'already_credited', data: res.data }
  }
  return { ok: false, status: res.status, conflict: null, data: res.data }
}

// ── B3-3 入账侧要用的四件事（4.6：仍然只有本模块碰这三张表）─────────────────

/**
 * 按我方单号读一行（确认态轮询与入账都从这一条进）。
 * 🔴 返回 null ＝ 库里没这单（不是故障）。调用方要分清"没这单"与"查失败"：前者在 4.5 是
 *   `no_such_order` 那一档（要落 anomaly 行），后者只能报"暂时不可用"。
 */
export async function getOrderRow(env, outTradeNo) {
  const res = await serviceRoleFetch(
    env,
    // 🔴 `platform` 必须在列里：E-28 判丙之后它进了判定（`evaluateRefund` 的 `revokeNow`），
    //   漏了它 ⇒ 安卓的单也永远判成"不当场撤"，2026-10-05 夜真机就是这么撞的（与 E-31 同一族：
    //   另一条读路 `listOrdersByOpenid` 有这一列，所以"申请端点能跑"证明不了它读得全）。
    //   判据＝`test:refund` 2.0b（两个生产者的 select 都要覆盖资格函数读的每个 `row.X`）。
    `${ORDERS}?select=id,user_id,provider,payer_openid,product_id,goods_price,currency_type,env,` +
      `buy_quantity,status,paid_at,wx_order_id,wxpay_order_id,out_trade_no,created_at,expires_at,is_duplicate,paid_after_close,anomaly_reason,platform` +
      `&out_trade_no=eq.${encodeURIComponent(outTradeNo)}&limit=1`,
  )
  if (!res.ok) throw fail('pro_order_lookup_failed', res.status, JSON.stringify(res.data))
  const rows = Array.isArray(res.data) ? res.data : []
  return rows[0] || null
}

/**
 * 把一张 pending 标成 `anomaly`（✅ E-17 判丙，owner 2026-10-05）。
 * 目前唯一的使用场景：主动查单回"平台已退款"而我方这张单从没入过账。那一支既不能走 `closed`
 * （语义是"没付过"，而它付过又退了），也不该把用户永久挡在门外（409 是死循环：那张单永远
 * 停在 pending、每次查单永远回 refunded）。
 * 🔴 三条边界：
 *   · 这**不是**退款状态机：不写 `refunded`、不动账本、不撤权益——那些是 B4 的
 *     `xpay_refund_notify` 那一支（D-22）。这里只做一件事：把"钱与货对不上"这件事落到
 *     一个 A3 巡检看得见的状态上（`pro-ops.sql` 的 A3 就是 `where status='anomaly'`）。
 *   · 过滤条件与 `closePendingOrder` 同形（`status=eq.pending`）：与轮询／推送撞车时匹配 0 行，
 *     绝不把已付单改成 anomaly。
 *   · `anomaly_reason` 必须是库侧 CHECK 认的九个值之一（`refunded_not_credited` 是本次新加的，
 *     见 `supabase/pro-billing-e16-e17-migration.sql`）。写错值不是"日志里看不见"，是 23514 冒出来。
 */
export async function markOrderAnomaly(env, outTradeNo, { reason, note }) {
  const body = { status: 'anomaly', anomaly_reason: String(reason), updated_at: new Date().toISOString() }
  if (note) body.note = String(note)
  const res = await serviceRoleFetch(env, `${ORDERS}?out_trade_no=eq.${encodeURIComponent(outTradeNo)}&status=eq.pending`, {
    method: 'PATCH',
    body,
    prefer: 'return=representation',
  })
  if (!res.ok) throw fail('pro_order_mark_anomaly_failed', res.status, JSON.stringify(res.data))
  // 匹配 0 行在这里是**合法**的（与轮询／推送撞车，那行已不是 pending）⇒ 不抛，但要把"没改到"
  // 这件事交回调用方记日志：静默的"我以为改了"与 markOrderPaid 那次是同一类错，只是这一支后果轻。
  return { matched: Array.isArray(res.data) && res.data.length > 0 }
}
/**
 * 把一张 pending 置 `closed`（4.5 前置④"换档／过期"那一支；✅ E-14 判乙 ⇒ 现在**先查单**、
 * 查得未付才调它，见 `proCredit.queryOrderState` 在下单端点里的那一支）。
 * 🔴 过滤条件必须带 `status=eq.pending`：与推送／轮询撞上时（旧单刚被记成 paid）这条 PATCH
 *   匹配 0 行 ⇒ 不会把已付单改回未付。匹配 0 行不是错误，调用方继续建新单——
 *   但返回值里带 `matched`，让调用方能把它记进日志（"我以为关掉了"与"确实关掉了"要能分开）。
 * ⚠️ 残余照旧（4.5 前置④残余①）：关单接口未证（R-9 ⑦）⇒ 这只是**我方口径**的关闭，
 *   平台侧那张单可能仍可付 ⇒ 迟到付款由 `closed` 继续分支 ＋ `paid_after_close` 接住。
 */
export async function closePendingOrder(env, outTradeNo) {
  const res = await serviceRoleFetch(env, `${ORDERS}?out_trade_no=eq.${encodeURIComponent(outTradeNo)}&status=eq.pending`, {
    method: 'PATCH',
    body: { status: 'closed', updated_at: new Date().toISOString() },
    prefer: 'return=representation',
  })
  if (!res.ok) throw fail('pro_order_close_failed', res.status, JSON.stringify(res.data))
  return { matched: Array.isArray(res.data) && res.data.length > 0 }
}

// ── 外部退款撤账（E-20②：`xpay_refund_notify` 是 D-22 认定的**唯一**撤账触发源）──────
//
// 🔴 这两支只在"查单已确认这单被退"之后才允许调（`proCredit.refundOrder` 把那道门）。
//   本模块不查平台——它只负责"写对形状"，事实确认在上一层，与入账那一对（`markOrderPaid`
//   ＋`insertLedgerRow`）是同一个分工。
// ⚠️ B4 的**申请侧**（`pro_refund_requests`、点了就撤、iOS 那一支不撤）还没做；这两支是
//   "钱已从用户那里回来"这一侧的最小正确动作，B4 落地时复用它们、不另写第三份。

/**
 * 撤掉这一单的账本行（权益当场消失——折叠排除 `revoked_at` 非空的行，4.3）。
 * 🔴 过滤 `revoked_at=is.null` ⇒ 重放安全：第二次撤匹配 0 行，不会把撤销时刻挪后（那是留痕的
 *   "什么时候退的"），也不会让一次网络抖动变成"撤了两次"。
 * ⚠️ 留痕**不在这张表上**：`pro_ledger` 按 4.2 刻意没有 `operator`／`note` 两列（它是权益的
 *   事实来源，不是工单）⇒ "谁撤的、怎么核实的"写在订单行上（`markOrderRefunded` 那一支）。
 * ⇒ 所以匹配 0 行**不是错误**：一张从没入账的单本来就没有可撤的行（调用方按 `matched` 记日志）。
 */
export async function revokeLedgerForOrder(env, orderId) {
  const res = await serviceRoleFetch(
    env,
    `/rest/v1/pro_ledger?order_id=eq.${encodeURIComponent(orderId)}&revoked_at=is.null`,
    {
      method: 'PATCH',
      body: { revoked_at: new Date().toISOString() },
      prefer: 'return=representation',
    },
  )
  if (!res.ok) throw fail('pro_ledger_revoke_failed', res.status, JSON.stringify(res.data))
  const rows = Array.isArray(res.data) ? res.data : null
  if (rows === null) throw fail('pro_ledger_revoke_unreadable', res.status, 'PATCH 没回 representation（Prefer 被吞？）')
  return { matched: rows.length }
}

/**
 * 订单 `paid → refunded`（4.5 状态转换：退款完成那一格）。留痕两列是 D-9a 要求的：
 * `operator` 写触发源（`xpay_refund_notify`／将来 `admin:<名字>`），`note` 写"怎么核实的"。
 * 🔴 过滤只吃 `status=eq.paid`，两个理由都是硬的：
 *   ① 库侧 CHECK `status not in ('paid','refunded') or paid_at is not null` ⇒ 一张 `pending`
 *     或 `closed`（`paid_at` 为空）的行被改成 `refunded` 会直接 23514，那笔 PATCH 整条失败；
 *   ② 语义上"从没发过权益的单"不该被写成"退过款"——那一支是 E-17 判丙的 `anomaly`
 *     （`refunded_not_credited`），出边只有人工。
 * ⇒ 所以匹配 0 行是**合法且要有说法**的一种结果，调用方按 `matched` 分档，别当成功。
 */
export async function markOrderRefunded(env, outTradeNo, { operator, note }) {
  const body = { status: 'refunded', updated_at: new Date().toISOString() }
  if (operator) body.operator = String(operator)
  if (note) body.note = String(note)
  const res = await serviceRoleFetch(env, `${ORDERS}?out_trade_no=eq.${encodeURIComponent(outTradeNo)}&status=eq.paid`, {
    method: 'PATCH',
    body,
    prefer: 'return=representation',
  })
  if (!res.ok) throw fail('pro_order_mark_refunded_failed', res.status, JSON.stringify(res.data))
  const rows = Array.isArray(res.data) ? res.data : null
  if (rows === null) throw fail('pro_order_mark_refunded_unreadable', res.status, 'PATCH 没回 representation（Prefer 被吞？）')
  return { matched: rows.length }
}

// ── B4 退款申请侧（4.2 第三张表；入口③用户自助申请与订单页的进度可见）────────────
//
// 🔴 这张表**没有 openid 列**（4.2 刻意不建 FK），所以"每个付款微信一次"这类额度判据
//   只能两步走：先按 `payer_openid` 取出这个微信名下的所有 `order_id`，再按 `order_id=in.(…)`
//   读申请行。别为了少一次读就给申请表加一列 openid——那会把"额度按付款微信算"这条
//   口径同时写在两处（一处漏改就静默失真）。

/** 某部微信名下的全部订单主键（额度判据的寻址用；🔴 不设 limit——漏读会把已用额度算少） */
export async function orderIdsByOpenid(env, openid) {
  const res = await serviceRoleFetch(
    env,
    `${ORDERS}?select=id&provider=eq.${PROVIDER}&payer_openid=eq.${encodeURIComponent(openid)}`,
  )
  if (!res.ok) throw fail('pro_order_id_list_failed', res.status, JSON.stringify(res.data))
  return (Array.isArray(res.data) ? res.data : []).map((r) => String(r.id)).filter(Boolean)
}

/**
 * 落一行退款申请（入口③）。🔴 只有**通过资格判据**的申请才允许走到这里（6.1 修正一：
 * 不合格当场拒、不落行——代价是"多少人试过退款"从此没有落点，那是已认的账）。
 * `kind='manual'`／`'duplicate'` 不耗额度，但 `manual` 必须带 `operator`＋`note`（D-4：
 * 那是唯一"由我方主动生成退款"的通道，没有留痕就等于没有门）。
 */
export async function insertRefundRequest(env, { orderId, kind, operator, note }) {
  const body = { order_id: String(orderId), kind: String(kind), status: 'pending' }
  if (operator) body.operator = String(operator)
  if (note) body.note = String(note)
  const res = await serviceRoleFetch(env, '/rest/v1/pro_refund_requests', {
    method: 'POST',
    body,
    prefer: 'return=representation',
  })
  if (!res.ok) return { ok: false, status: res.status, data: res.data }
  const rows = Array.isArray(res.data) ? res.data : []
  return { ok: true, status: res.status, row: rows[0] || null }
}

/**
 * 一批订单的申请行（订单页要 join 出 `refund_status`——6.1 ⑦"进度必须自己看得见"：
 * 点了就撤之后，用户全靠打开账户页才知道结果，被拒还原权益时更不能没有说法）。
 * ⚠️ 一次 `in.` 读，🔴 不在端点上按行循环打库（列表 50 行＝50 次读是另一种静默劣化）。
 */
export async function refundRequestsByOrders(env, orderIds) {
  const ids = (orderIds || []).map((x) => String(x)).filter(Boolean)
  if (ids.length === 0) return []
  const res = await serviceRoleFetch(
    env,
    // 🔴 `id` 必须在列里：两个消费者要拿它**寻址**——管理端要把它自己那条排除掉（`others.filter(r.id !== id)`），
    //   接收器要按它关掉那一行（E-36 判甲）。漏了就又是 E-31／E-35 那一族（消费者在读生产者没喂的键）。
    `/rest/v1/pro_refund_requests?select=id,order_id,kind,status,requested_at,executed_at,note` +
      `&order_id=in.${encodeURIComponent('(' + ids.join(',') + ')')}&order=requested_at.desc`,
  )
  if (!res.ok) throw fail('pro_refund_list_failed', res.status, JSON.stringify(res.data))
  return Array.isArray(res.data) ? res.data : []
}

/** 按主键读一行订单（管理端要拿它判"这笔现在是什么状态"，🔴 不靠申请行自己说） */
export async function getOrderById(env, orderId) {
  const res = await serviceRoleFetch(
    env,
    `${ORDERS}?select=id,user_id,provider,payer_openid,product_id,goods_price,env,buy_quantity,status,paid_at,wx_order_id,wxpay_order_id,out_trade_no,platform&id=eq.${encodeURIComponent(orderId)}&limit=1`,
  )
  if (!res.ok) throw fail('pro_order_lookup_failed', res.status, JSON.stringify(res.data))
  const rows = Array.isArray(res.data) ? res.data : []
  return rows[0] || null
}

/** 读一行退款申请（管理端） */
export async function getRefundRequest(env, id) {
  const res = await serviceRoleFetch(
    env,
    `/rest/v1/pro_refund_requests?select=id,order_id,kind,status,requested_at,executed_at,wx_refund_id,operator,note&id=eq.${encodeURIComponent(id)}&limit=1`,
  )
  if (!res.ok) throw fail('pro_refund_lookup_failed', res.status, JSON.stringify(res.data))
  const rows = Array.isArray(res.data) ? res.data : []
  return rows[0] || null
}

/**
 * 管理端把申请推到终态（入口④）。🔴 过滤 `status=eq.pending`：重放／两个管理员同时点开时
 * 匹配 0 行 ⇒ 不会把已 `done` 的行改回 `rejected`（那会把"还回去"的判定建立在一条假状态上）。
 * ⚠️ 4.2 与验收 #68 都写着"`done` 必须同时填 `wx_refund_id` 与 `operator`/`note`——**CHECK 会挡空**"，
 *   但 2026-10-05 核对 DDL 后确认：**库里那两条 CHECK 不存在**（`pro_refund_requests` 只有 kind 与
 *   status 两条枚举 CHECK）。⇒ 现在这道门写在调用方（`functions/admin/pro-refunds.js`），
 *   偏离登记在正本 §十六 E-29。要补库侧约束就得走一次增量迁移（`check (status <> 'done' or ...)`）。
 */
export async function finalizeRefundRequest(env, id, { status, operator, note, wxRefundId }) {
  const body = { status: String(status), "operator": String(operator), note: String(note), executed_at: new Date().toISOString() }
  if (wxRefundId) body.wx_refund_id = String(wxRefundId)
  const res = await serviceRoleFetch(env, `/rest/v1/pro_refund_requests?id=eq.${encodeURIComponent(id)}&status=eq.pending`, {
    method: 'PATCH',
    body,
    prefer: 'return=representation',
  })
  if (!res.ok) throw fail('pro_refund_finalize_failed', res.status, JSON.stringify(res.data))
  const rows = Array.isArray(res.data) ? res.data : null
  if (rows === null) throw fail('pro_refund_finalize_unreadable', res.status, 'PATCH 没回 representation（Prefer 被吞？）')
  return { matched: rows.length, row: rows[0] || null }
}

/**
 * 把那一笔**还回去**（`rejected` 那一支：6.1 修正④"被拒／失败把那一笔还回去并归还额度"）。
 * 🔴 过滤 `revoked_at is not null` ⇒ 只还原"被我们撤掉的那一行"，不去碰本来就没撤过的行；
 *   调用方必须先确认"这一笔的撤销确实是这次申请造成的"（订单还 `paid`、没有别的生效申请），
 *   否则外部退款（钱真的退了）会被这一句还原成"钱退了、权益还在"——那正是 E-20② 的现场。
 */
export async function unrevokeLedgerForOrder(env, orderId) {
  const res = await serviceRoleFetch(
    env,
    `/rest/v1/pro_ledger?order_id=eq.${encodeURIComponent(orderId)}&revoked_at=is.not.null`,
    {
      method: 'PATCH',
      body: { revoked_at: null },
      prefer: 'return=representation',
    },
  )
  if (!res.ok) throw fail('pro_ledger_unrevoke_failed', res.status, JSON.stringify(res.data))
  const rows = Array.isArray(res.data) ? res.data : null
  if (rows === null) throw fail('pro_ledger_unrevoke_unreadable', res.status, 'PATCH 没回 representation（Prefer 被吞？）')
  return { matched: rows.length }
}
