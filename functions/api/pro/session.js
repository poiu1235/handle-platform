// GET /api/pro/session —— 会员态的会话下发（S-1 已判＝乙：新开一个端点，不塞进
// 既有那 4~5 个签发会话的响应里）。
//
// 为什么值得新开一个而不是搭车：
//   · 签发会话的响应点有五个（wechat-login / login / refresh / verify-signup / register 系），
//     搭车＝五处都要改、Web 侧还得改 applySession 的透传；新端点＝一处真相、且**可整体摘除**
//     （删掉本文件 + 端上那两个模块就回到今天，既有登录链一行不动）。
//   · 它坐在 functions/api/ 下面 ⇒ functions/api/_middleware.js 已经验过 Bearer 并把
//     context.data.user 填好，这里不重复验签（那条豁免机制的缺失也就不需要动它）。
//
// 契约（与端上 src/lib/proStatus.ts 的 applyProPayload 一一对齐，改动必须两侧同批）：
//   { proUntil: string|null, remainingDays: number|null, serverNow: string,
//     wallsEnabled: boolean, caps: { notes, balances, cards } | null }
// 🔴 永不下发 openid／payer_openid／callback_raw／user_id（4.6）。
import { json } from '../../_lib/supabase.js'
import { getProView, readProFlags, capsForWire } from '../../_lib/proCoverage.js'

export async function onRequestGet(context) {
  const { env, data } = context
  const userId = data && data.user ? data.user.id : null
  // 中间件正常会先拦掉无 token 的请求；这一行是纵深，不是主防线
  if (!userId) return json({ error: '未登录' }, 401)

  try {
    const view = await getProView(env, userId)
    const flags = readProFlags(env)
    return json({
      proUntil: view.proUntil,
      remainingDays: view.remainingDays,
      serverNow: view.serverNow,
      wallsEnabled: flags.walls,
      caps: capsForWire(view.isCovered, flags.walls),
    })
  } catch (err) {
    // 渲染路径 fail-closed（7.2）：查询失败就按免费档显示。
    // ⚠️ 这不给任何人多一分权益——墙的真正强制在写路径，而写路径永远读库（7.2 末段）。
    //    也不返回 5xx：端上拿到"明确的免费档"比拿到一个需要翻译的错误码更省事，
    //    且刷新会话失败不该把界面卡在骨架态。
    console.error('[pro/session] lookup failed:', (err && err.code) || (err && err.message) || 'unknown')
    return json({
      proUntil: null,
      remainingDays: null,
      serverNow: new Date().toISOString(),
      wallsEnabled: false,
      caps: null,
    })
  }
}
