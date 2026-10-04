// 入账事务——**唯一一份实现**（PRD v3 4.5 第 5 步；4.6 那五个入口共用它）。
//
// 为什么单独一个文件而不是写在端点里：入账有两个触发源（②平台推送、④管理端补写）加一个
// 半触发源（6.4 的确认态轮询／进站查单）。三处各写一遍"查单→回填→写账本"，
// 漏一项的概率接近 1，而漏的那一项通常是"幂等"或"金额快照"这种出事就是钱的那项。
//
// 🔴 三条不能商量的规矩（都来自正本，写在这里是因为它们是**代码约束**不是纪律）：
// 1. **发货只认查单结果**（6.2 铁律 2）：推送、端上 `success` 回调都只是触发器。
//    本函数唯一的"已付"依据是 `xpayQueryOrder` 回来的 `order.status`。
// 2. **查单失败 ≠ 未付**：`query_error`／`unreachable` 一律原样回给调用方，
//    由它决定"维持 pending、应答失败让平台重推"（4.5 三态表）。把它当"未付"会把一次
//    网络抖动做成**永久漏发**（应答成功＝替平台放弃剩下 15 次重推）。
// 3. **期限查不到就不入账**（3.3 门槛②）：`duration_days` 是权益本体，猜一个数等于凭空发权益；
//    宁可让这一单停在 pending 等人工，也不要"先给 30 天看看"。
//
// ⚠️ 幂等的两道闸：`markOrderPaid` 的 PATCH 只吃 `pending|closed`（已付单的 `paid_at` 不会被挪），
//   而**真正的双入账闸门是 `pro_ledger.order_id` 那条 unique** ⇒ 并发两路同时进来时
//   第二条会拿到 `already_credited`，那是**成功**不是错误（见下面的分支注释）。
import { xpayQueryOrder, classifyQueryResult } from './proXpay.js'
import { getOrderRow, markOrderPaid, ledgerExistsForOrder, insertLedgerRow } from './proStore.js'
import { durationDaysFor } from './proCatalog.js'
import { getCoverageByOpenid, readProFlags, RENEW_WINDOW_DAYS, PROVIDER } from './proCoverage.js'

/**
 * 入账（或确认"已经入过"）。
 * @returns {outcome, ...} —— outcome 是**给调用方决定应答用的枚举**，不是布尔：
 *   `credited` 本次入账｜`already` 早就入过（幂等成功）｜`unpaid` 平台说没付｜
 *   `closed` 平台说这单已关闭｜`refunded` 平台说已退款（而我们没入账 ⇒ 异常）｜
 *   `not_found` 平台查无此单｜`no_local_order` 我方库里没这单｜
 *   `query_error` 查单本身没成功（含网络）｜`product_missing` 道具期限查不到｜`bad_order` 行数据不可用
 */
export async function creditOrder(env, outTradeNo, { fetchImpl } = {}) {
  let row = null
  try {
    row = await getOrderRow(env, outTradeNo)
  } catch (err) {
    return { outcome: 'query_error', stage: 'local_order_read', code: (err && err.code) || 'read_failed' }
  }
  if (!row) return { outcome: 'no_local_order', outTradeNo }

  // 已付/已退的单：不再查单、不再改状态（4.5 第 3 步"拒绝复活"），但要检查账本在不在——
  // "改了状态、没写成账本"这个两步写是可能被打断的，缺的那一行在这里补上（数据全从行里取，
  // 不接受调用方传值 ⇒ 与 4.6 对补写入口的那条要求同形）。
  if (row.status === 'paid' || row.status === 'refunded') {
    return await ensureLedgerForPaidRow(env, row, { queried: false })
  }

  if (!row.payer_openid) return { outcome: 'bad_order', reason: 'no_payer_openid' }
  // 🔴 读不到主键 ⇒ 不入账。缺 order_id 的账本行是**三样东西同时失效**：unique 闸门（Postgres 的
  //   unique 允许任意多行 null）、B4 的撤销（按 order_id 找行）、6.5 的对账口径。
  //   `select=id` 里本来就有它，走到 null 只可能是有人改了视图／列 ⇒ 宁可让这单停在 pending。
  if (!row.id) return { outcome: 'bad_order', reason: 'no_order_id' }
  const envFlag = Number(row.env) === 1 ? 1 : 0
  const q = await xpayQueryOrder({
    env,
    openid: String(row.payer_openid),
    orderId: String(row.out_trade_no),
    envFlag,
    fetchImpl,
  })
  const kind = classifyQueryResult(q)

  if (kind === 'not_found') return { outcome: 'not_found', errcode: q.errcode, errmsg: q.errmsg }
  if (kind === 'error' || kind === 'unreachable') {
    // 🔴 这一支绝不能落到"未付"：未付会让平台侧放弃重推（应答成功）或让端上停止轮询
    return { outcome: 'query_error', errcode: q.errcode, errmsg: q.errmsg, stage: 'query' }
  }
  if (kind === 'unpaid') return { outcome: 'unpaid', platformStatus: statusOf(q) }
  if (kind === 'closed') return { outcome: 'closed', platformStatus: statusOf(q) }
  if (kind === 'refunded') {
    // 平台说已退而我方这单还是 pending ⇒ 要么钱根本没到我们账上、要么有人在后台直接退了。
    // 不入账（退了的钱不该换权益），但要留痕让人去看——4.5 的 `anomaly` 那一档。
    return { outcome: 'refunded', platformStatus: statusOf(q) }
  }

  // kind === 'paid'
  const paid = paidTimeOf(q)
  if (!paid.ok) {
    // ⚠️ 拿不到支付时刻时**退到"本次确认时刻"并留一条 error 日志**：7 天退款窗口的起点会偏后，
    //    偏后对用户有利（窗口更长）、对我们不利 ⇒ 这是可接受的偏向，但不能静默。
    console.error('[proCredit] paid_time missing, fallback to now:', JSON.stringify({ outTradeNo, raw: paid.raw }))
  }
  const durationDays = durationDaysFor(row.product_id)
  if (!durationDays) {
    // 🔴 不入账。这一单会停在 pending，由 6.5 的人工巡检（A4）看见 ⇒ 处置是"改回商品表或人工补"，
    //    绝不是"先给个默认天数"。
    console.error('[proCredit] duration missing for product_id:', String(row.product_id))
    return { outcome: 'product_missing', productId: row.product_id }
  }

  const flags = readProFlags(env)
  let isDuplicate = false
  try {
    const cov = await getCoverageByOpenid(env, String(row.payer_openid), flags.proEnv)
    // 4.2 `is_duplicate` 的定义：入账时发现**付款时刻已有剩余 > 续购窗口**的有效权益（并发多付）
    isDuplicate = cov.remainingDays !== null && cov.remainingDays > RENEW_WINDOW_DAYS
  } catch (err) {
    // 判不出重复只影响**退款分类**（duplicate 类不耗额度），不影响权益——折叠对重叠区间自动接龙。
    // ⇒ 留 false 并记日志，🔴 不要因为这次读失败就拒绝入账（钱已经付实了）。
    console.error('[proCredit] coverage read failed, is_duplicate stays false:', (err && err.code) || 'unknown')
  }

  try {
    await markOrderPaid(env, {
      outTradeNo: String(row.out_trade_no),
      paidAtIso: paid.iso,
      wxOrderId: wxOrderIdOf(q),
      isDuplicate,
      // 我方已把这张置 closed、钱后来才回来 ⇒ 4.5 的"复活"那一支，必须落列（默认 false 就统计不到）
      paidAfterClose: row.status === 'closed',
      // 🔴 时刻是猜的时候要把这件事写进数据，不能只写日志：7 天退款窗口的起点由它算，
      //   而人工巡检（6.5）读的是行，读不到某一次部署的 console。
      note: paid.ok ? null : 'paid_time_missing:used_confirmation_time',
    })
  } catch (err) {
    // 状态没改成 ⇒ 账本也不写（写了就出现"有权益但订单还挂着 pending"的形状）。
    // 订单留在 pending，下一次轮询／重推会重来一遍。
    console.error('[proCredit] markOrderPaid failed:', (err && err.code) || 'unknown')
    return { outcome: 'query_error', stage: 'mark_paid', code: (err && err.code) || 'mark_paid_failed' }
  }

  const ins = await writeLedger(env, {
    provider: PROVIDER,
    order_id: String(row.id), // 🔴 缺了它这一行既去不了重（unique 只吃非 null）也撤不掉（B4 按 order_id 找账本行）
    payer_openid: String(row.payer_openid),
    buyer_user_id: row.user_id || null, // 只作 4.7 那句"暂未生效"的展示判据，不参与判定
    env: envFlag,
    effective_at: paid.iso,
    duration_days: durationDays,
  })
  if (ins.conflict === 'already_credited') {
    // 🔴 幂等成功，不是错误：并发两路（轮询 + 推送）同时进来时后到的就是这一支。
    //   回 500 会让端上以为"付了钱没到账"而再买一次——那才是这条路径真正的伤害。
    return { outcome: 'already', paidAt: paid.iso, durationDays, isDuplicate }
  }
  if (!ins.ok) {
    console.error('[proCredit] ledger insert failed:', JSON.stringify(ins.data))
    // 订单已被标 paid 而账本没写成 ⇒ 下一次轮询/推送会走 `ensureLedgerForPaidRow` 补上
    return { outcome: 'query_error', stage: 'ledger_insert', code: ins.status }
  }
  return { outcome: 'credited', paidAt: paid.iso, durationDays, isDuplicate, platformStatus: statusOf(q) }
}

/**
 * 只查单、不入账，回答"这张 pending 单到底付了没有"——4.5 前置④"换档／过期先查单"那一支用。
 * @returns {outcome} 'paid'（⇒ 不许关，改走入账）｜'unpaid'｜'closed'｜'not_found'（⇒ 可以关旧建新）｜'query_error'
 */
export async function queryOrderState(env, row, { fetchImpl } = {}) {
  const q = await xpayQueryOrder({
    env,
    openid: String(row.payer_openid),
    orderId: String(row.out_trade_no),
    envFlag: Number(row.env) === 1 ? 1 : 0,
    fetchImpl,
  })
  const kind = classifyQueryResult(q)
  if (kind === 'paid') return { outcome: 'paid', platformStatus: statusOf(q) }
  if (kind === 'refunded') return { outcome: 'refunded', platformStatus: statusOf(q) }
  if (kind === 'unpaid' || kind === 'closed' || kind === 'not_found') return { outcome: 'unpaid', via: kind }
  return { outcome: 'query_error', errcode: q.errcode, errmsg: q.errmsg }
}

/** 已付/已退的行缺账本时补上（数据全部从订单行取，不接受调用方传值） */
async function ensureLedgerForPaidRow(env, row, { queried }) {
  if (!row.id || !row.payer_openid) return { outcome: 'bad_order', reason: row.id ? 'no_payer_openid' : 'no_order_id' }
  let exists = false
  try {
    exists = await ledgerExistsForOrder(env, String(row.id))
  } catch (err) {
    return { outcome: 'query_error', stage: 'ledger_read', code: (err && err.code) || 'read_failed' }
  }
  if (exists) return { outcome: 'already', paidAt: row.paid_at, repaired: false, queried }
  const durationDays = durationDaysFor(row.product_id)
  if (!durationDays) return { outcome: 'product_missing', productId: row.product_id }
  if (!row.paid_at) {
    // 状态是 paid 却没有 paid_at ⇒ 库里出现了 CHECK 本该挡住形状（check 要求 paid 必带 paid_at）。
    // 真看到就是数据被绕过端点改过，不猜时刻、不入账。
    console.error('[proCredit] paid order without paid_at:', String(row.out_trade_no))
    return { outcome: 'bad_order', reason: 'paid_without_paid_at' }
  }
  const ins = await writeLedger(env, {
    provider: PROVIDER,
    order_id: String(row.id),
    payer_openid: String(row.payer_openid),
    buyer_user_id: row.user_id || null,
    env: Number(row.env) === 1 ? 1 : 0,
    effective_at: row.paid_at,
    duration_days: durationDays,
  })
  if (ins.conflict === 'already_credited') return { outcome: 'already', paidAt: row.paid_at, repaired: false, queried }
  if (!ins.ok) return { outcome: 'query_error', stage: 'ledger_insert', code: ins.status }
  console.error('[proCredit] repaired missing ledger row for a paid order:', JSON.stringify({ outTradeNo: row.out_trade_no }))
  return { outcome: 'credited', paidAt: row.paid_at, durationDays, repaired: true, queried }
}

/**
 * 写账本行的那一层薄壳：`proStore.insertLedgerRow` 的入口校验（少 order_id／少时刻／少期限）
 * 是**抛**出来的，本函数把它接住回成"这次没写成"。
 * 🔴 理由是这条链的调用方有三种（轮询、将来的推送、管理端补写），而任何一种里"抛到端点外面"
 *   都会变成 500——500 让用户以为"付了钱没到账"，进而再买一次；回"没到账但也没入账"才自愈得了
 *   （订单状态不变／下一次重读走 `ensureLedgerForPaidRow` 补）。日志照抛的那级别打。
 */
async function writeLedger(env, fields) {
  try {
    return await insertLedgerRow(env, fields)
  } catch (err) {
    console.error('[proCredit] ledger row refused at write entrance:', JSON.stringify({ code: (err && err.code) || 'unknown', missing: (err && err.detail) || null }))
    return { ok: false, status: (err && err.status) || 0, conflict: null, data: { rejected: (err && err.code) || 'unknown' } }
  }
}

function statusOf(q) {
  const o = q && q.data && q.data.order ? q.data.order : null
  return o && typeof o.status === 'number' ? o.status : null
}

/**
 * `paid_time` 是 **unix 秒**（2026-10-04 实测那行文档字段表，附录甲）⇒ ×1000。
 * 🔴 这条换算没有单元测试兜不住：忘了乘得到的不是报错，是"1970-01-21 到期"——
 *   折叠会把它判成已过期，用户付了钱却看不到会员，而且零异常日志。
 */
function paidTimeOf(q) {
  const o = q && q.data && q.data.order ? q.data.order : null
  const raw = o ? o.paid_time : null
  const n = typeof raw === 'string' && raw !== '' ? Number(raw) : raw
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
    const ms = n < 1e11 ? n * 1000 : n // 秒级 ×1000；万一平台给的是毫秒（>1e11）就别再乘
    return { ok: true, iso: new Date(ms).toISOString(), raw: n }
  }
  return { ok: false, iso: new Date().toISOString(), raw }
}

function wxOrderIdOf(q) {
  const o = q && q.data && q.data.order ? q.data.order : null
  if (!o) return null
  const v = o.wx_order_id || o.channel_order_id || o.wxpay_order_id
  return typeof v === 'string' && v !== '' ? v : null
}
