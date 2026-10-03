// 会员判定与档位上限在 CF 侧的唯一落点（PRD v3 4.3／4.4／8.1／8.2 #10）。
//
// 🔴 全仓对 `/rest/v1/rpc/pro_coverage` 的调用**只有 callProCoverage() 这一处**（验收 #39 的
//   CF 半边，静态判据在 scripts/test-pro-coverage.mjs）。别处要知道"是不是会员／还剩几天"
//   就调本模块的导出函数——不要在 JS 里再排一遍 effective_at + duration_days，也不要在 JS 里
//   做时区归一：那正是 D-2 撤掉 ⓑ（落库 + 重算）时用的同一个理由——靠每条路径自觉。
//
// 🔴 开关与 env 只从 `env`（wrangler 部署变量）读，**绝不从请求体/请求头读**（8.3 第 1 条：
//   否则端上能自己把墙关掉）。判据是"这两个标识符在 functions/ 里只出现在本文件"。
//
// ⚠️ 成本账（探测类代码的四笔账）：一次判定＝1 次 identity 读 + 1 次 rpc，都走 service_role。
//   会话端点每次进站一次；墙开着时每个写入口另加这两次。V1 接受——真成瓶颈再走 4.3 那条
//   退路（加一列"时刻"缓存，且唯一写入口仍是这个函数），别提前加，更别缓存成布尔。
//   🔴 墙关着时本模块**一次数据库都不问**（今天现网就是这个形态，不能白多两个请求）。
import { serviceRoleFetch } from './userAuth.js'

export const PROVIDER = 'wechat_mp'

// 🔴 档位数值的唯一来源（3.3 上线门槛②：「档位数值只能有一个来源」）。
//   端上一律不编译这些数，走会话下发（8.1）；写路径的墙也从这里取，两端不会漂。
export const CAPS = {
  member: { notes: 500, balances: 100, cards: 100 },
  free: { notes: 200, balances: 50, cards: 50 },
}

function isOn(v) {
  // 只有显式 'true'/'1' 算开；缺失、空串、'false'、拼错一律算关（fail-closed，与 7.2 同构）。
  // 注意 wrangler [vars] 的值恒为字符串，不是布尔。
  const s = String(v ?? '').trim().toLowerCase()
  return s === 'true' || s === '1'
}

export function readProFlags(env) {
  return {
    walls: isOn(env.PRO_WALLS_ENABLED),
    purchase: isOn(env.PRO_PURCHASE_ENABLED),
    // ⚠️ 必须转成数字再发 rpc：pro_coverage 的 p_env 是 integer，而 [vars] 给的是字符串 '0'。
    //    （同一族坑：B0 里 pro_coverage 的 p_env 曾声明成 smallint，字面量 0 直接 42883。）
    proEnv: Number(env.PRO_ENV) === 1 ? 1 : 0,
  }
}

// 本账号**当前那一条** wechat_mp identity 的 openid。
// 🔴 反例判据 1：查询必须锁在 user_id + provider 上（unique(user_id,provider) 保证至多一行），
//   绝不写成"全局存在某个账号绑着这个 openid 且有权益"——那与本账号是否真绑着购买微信无关。
// 返回 null ＝ 这个账号没绑微信（纯 Web 账号），是事实不是故障。
async function currentWechatOpenid(env, userId) {
  const res = await serviceRoleFetch(
    env,
    `/rest/v1/user_identities?select=openid&user_id=eq.${encodeURIComponent(userId)}` +
      `&provider=eq.${PROVIDER}&limit=1`,
  )
  if (!res.ok) {
    const err = new Error('pro_identity_lookup_failed')
    err.code = 'pro_identity_lookup_failed'
    err.status = res.status
    throw err
  }
  const rows = Array.isArray(res.data) ? res.data : []
  const openid = rows[0] && rows[0].openid
  return typeof openid === 'string' && openid !== '' ? openid : null
}

// 🔴 rpc 唯一调用点。p_now 用调用方传进来的同一个时刻（见 getProView 那条"同源"注释）。
async function callProCoverage(env, openid, nowIso, proEnv) {
  const res = await serviceRoleFetch(env, '/rest/v1/rpc/pro_coverage', {
    method: 'POST',
    body: { p_provider: PROVIDER, p_openid: openid, p_env: proEnv, p_now: nowIso },
  })
  if (!res.ok) {
    const err = new Error('pro_coverage_rpc_failed')
    err.code = 'pro_coverage_rpc_failed'
    err.status = res.status
    throw err
  }
  // ⚠️ PostgREST 对"RETURNS record + OUT 参数"的函数到底回对象还是单元素数组，**没有一手证据**
  //   （B0 的核对文件只证明了 SQL 侧 `(f()).col` 可用，那是另一条路径）。⇒ 两种形状都吃；
  //   首接真单时看清实际形状，再把这一行收紧成一种并在此注明出处（不许留成"以防万一"的双分支）。
  const row = Array.isArray(res.data) ? res.data[0] : res.data
  const d = row && typeof row === 'object' ? row : {}
  const rem = typeof d.remaining_days === 'string' && d.remaining_days !== '' ? Number(d.remaining_days) : d.remaining_days
  return {
    isCovered: d.is_covered === true,
    validUntil: typeof d.valid_until === 'string' && d.valid_until !== '' ? d.valid_until : null,
    remainingDays: typeof rem === 'number' && Number.isFinite(rem) ? Math.trunc(rem) : null,
  }
}

/**
 * 档位映射。🔴 wallsEnabled=false 时返回 null＝**没有墙**，不是"免费档的新数值"（8.3 关态判据）：
 * 现网今天便利贴是单一 500、余额与卡根本没有行数墙，开关关着就不能凭空造出一面 200 的墙。
 */
export function capsForWire(isCovered, wallsEnabled) {
  if (!wallsEnabled) return null
  const c = isCovered ? CAPS.member : CAPS.free
  return { notes: c.notes, balances: c.balances, cards: c.cards }
}

/**
 * 一次会员判定的全部渲染侧信息（会话端点用）。
 * 抛错＝identity 读失败或 rpc 失败，由调用方按"渲染路径 fail-closed"处理（7.2）。
 * 🔴 返回值里**不含 openid**：判定用的是服务端自己查出来的那一条，端上没有需要它的场景。
 */
export async function getProView(env, userId) {
  // 同一个时刻既喂给判定、又原样作为 serverNow 下发 ⇒ 端上的偏移与库内判定同源，
  // 不会出现"服务端算的是 T、端上拿 T' 比较"那种两秒缝（4.4 评审第 22 条要的就是这个）。
  const serverNow = new Date().toISOString()
  const flags = readProFlags(env)
  const openid = await currentWechatOpenid(env, userId)
  if (openid === null) {
    return { serverNow, isCovered: false, proUntil: null, remainingDays: null, hasWechat: false }
  }
  const c = await callProCoverage(env, openid, serverNow, flags.proEnv)
  return { serverNow, isCovered: c.isCovered, proUntil: c.validUntil, remainingDays: c.remainingDays, hasWechat: true }
}

/**
 * 写路径要的三样：墙开没开、这个人是不是会员、上限是多少。
 * 墙关着 ⇒ 直接返回，不碰数据库（B2 的七个写入口靠这条保持今天的零成本）。
 * ⚠️ 调用方 catch 到抛错时的正确动作是**放行 + logProLookupFailure**，不是拦（7.2 写路径）。
 */
export async function getProWallState(env, userId) {
  const flags = readProFlags(env)
  if (!flags.walls) return { wallsEnabled: false, isCovered: null, caps: null }
  const view = await getProView(env, userId)
  return { wallsEnabled: true, isCovered: view.isCovered, caps: capsForWire(view.isCovered, true) }
}

/**
 * 7.2 写路径"放行"的统一日志形状。
 * ⚠️ 放行**不写任何状态位**（写了就把 D-2 撤掉的可写派生态请回来）；也别把这条当成
 *   "有人会收到通知"——6.5 已定 V1 没有推送型告警，日志会滚掉，这笔残余是明记账的。
 */
export function logProLookupFailure(where, userId, err) {
  console.error(
    '[proCoverage] pro-cap-lookup-failed',
    JSON.stringify({ where, userId, code: err && err.code ? err.code : null, message: err && err.message ? err.message : null }),
  )
}
