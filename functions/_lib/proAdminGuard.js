// 管理端的两道门——🔴 **只有一个实现**，两个管理端端点（`/admin/pro-refunds`、`/admin/pro-anomaly`）共用。
//
// 为什么单独一个文件：这两个端点是全仓**唯二**能改钱与权益的终态的入口，而它们的凭证是同一把
// secret（`PRO_ADMIN_TOKEN`）、留痕要求也是同一条（D-9a：人工执行必须写"谁做的、怎么核实的"）。
// 抄两份的后果不是脏，是**漂移**：下一次有人在其中一份里把定长比较改成 `===`、或把
// "note 不许是空白"放宽成"传了就行"，另一份还是安全的——那意味着"这一族有门"这件事
// 再也没人能一眼确认。正本 4.6 对写模块说的是同一句话，这里只是把它用在鉴权侧。
//
// 🔴 两份门各自挡的是不同的失败，别合并语义：
//   · 缺 `PRO_ADMIN_TOKEN` ⇒ **503 `admin_disabled`**，不是 401。"没配置"与"凭证不对"必须分得开，
//     否则 2026-10-05 那次握手失败（我方 503 未配置，被读成签名错）会重演：排障的人往错方向查。
//   · `operator`／`note` 缺任一样 ⇒ **400 `admin_note_required`**，且必须在**任何写之前**返回。
//     库里那两条 CHECK 只兜 `pro_refund_requests`（E-29 判甲），`pro_orders` 侧**没有** CHECK，
//     所以这一格今天**只有这道门**——删掉它等于把留痕要求整个删掉（判据＝`test:anomaly` 6.3）。
import { json } from './supabase.js'

/** 定长比较：管理端凭证是攻击者可控输入的一部分，别用 `===` 的短路语义 */
function tokenEqual(a, b) {
  const x = String(a)
  const y = String(b)
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i)
  return diff === 0
}

/**
 * 第一道：凭证。🔴 必须在读请求体**之前**调用——未鉴权的输入不许触发任何解析后的动作
 * （`test:refund` 4.12 钉的就是"凭证不对时一次出网都没有"）。
 * @returns {Response|null} null＝放行；非 null 就是要直接回给调用方的那个响应
 */
export function adminTokenGate(request, env, logTag) {
  const expected = env.PRO_ADMIN_TOKEN
  if (!expected) {
    console.error(`[${logTag}] PRO_ADMIN_TOKEN missing — endpoint disabled`)
    return json({ error: '管理端未启用', code: 'admin_disabled' }, 503)
  }
  if (!tokenEqual(request.headers.get('x-admin-token') || '', expected)) {
    return json({ error: '凭证不对', code: 'admin_unauthorized' }, 401)
  }
  return null
}

/**
 * 第二道：留痕。返回**去掉首尾空白之后**的 `operator`／`note`（下游写库用的就是这两个值，
 * 所以"传了一串空格"在门口就死掉，不会变成库里一条看着有、其实空的留痕）。
 * @returns {{res:Response|null, operator:string, note:string}}
 */
export function adminTraceGate(body) {
  const operator = String((body && body.operator) || '').trim()
  const note = String((body && body.note) || '').trim()
  if (!operator || !note) {
    return { res: json({ error: '人工执行必须同时填 operator 与 note', code: 'admin_note_required' }, 400), operator, note }
  }
  return { res: null, operator, note }
}
