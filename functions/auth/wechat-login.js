import { json } from '../_lib/supabase.js'
import { code2session, wxTicketResponse } from '../_lib/wxTicket.js'
import { serviceRoleFetch, issueSessionByEmail } from '../_lib/userAuth.js'
import { rateGuard } from '../_lib/authGate.js'
import { createGuestUser, isGuestUser } from '../_lib/guestUser.js'
import { sendNotify, notifyTemplates } from '../_lib/mailer.js'

// openid 免登（D3 3.3.4 → D5 流程一）：冷启动 wx.login code → openid → 查映射。
// 门禁就是 code 本身——一次性、约 5 分钟时效、只能在小程序客户端内取得（3.3.5-2）。
//
// 命中映射：签发真实 Supabase 会话（generate_link + verify，R7 spike 定案，
// 现收敛到 _lib/userAuth.issueSessionByEmail），响应带 isGuest 供客户端分流 UI。
// 未命中：
//   GUEST_MODE=true（D5）→ 建访客 shadow user + 插映射 + 直接签发会话，
//     零摩擦落地（设计 1 章定位：小程序 = 轻量输入 + 大量查询，登录摩擦须趋零）；
//   GUEST_MODE=false → { bound: false }，维持 D3 原语义（回滚开关，只影响
//     「新建」——已建访客走命中分支不受开关影响，见设计 §10 回滚约束）。
//
// 免登命中若目标在 pending_deletions 置位期内 → 撤位（设计 2.3：重新登录就是
// 最自然的撤销动作，不需要任何 UI；清理位撤销后夜 job 不会再删，B27 双保险）。
export async function onRequestPost(context) {
  const { request, env, waitUntil } = context
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: '服务端未配置 SUPABASE_SERVICE_ROLE_KEY' }, 500)

  const { code } = await request.json().catch(() => ({}))
  const wx = await code2session(code, env)
  if (!wx.ok) return wxTicketResponse(wx)

  const found = await serviceRoleFetch(
    env,
    `/rest/v1/user_identities?select=user_id&provider=eq.wechat_mp&openid=eq.${encodeURIComponent(wx.openid)}`,
  )
  const userId = found.data?.[0]?.user_id

  if (!userId) {
    if (env.GUEST_MODE !== 'true') return json({ bound: false })

    // B10 建访客频控：60s/5 + 1h/50 双窗口（isolate 级，1.3「基础兜底」口径，
    // 攻击门槛本来就是真实微信会话的合法 code）
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
    if (rateGuard(`guest-create-60s:${ip}`) || rateGuard(`guest-create-1h:${ip}`, 50, 3_600_000)) {
      return json({ error: '尝试过于频繁，请稍后再试' }, 429)
    }

    const guest = await createGuestUser(env, { openid: wx.openid, unionid: wx.unionid })
    if (!guest.ok) return json({ error: '免登失败，请用邮箱登录' }, 500)
    const session = await issueSessionByEmail(env, guest.email)
    if (!session) return json({ error: '免登失败，请用邮箱登录' }, 500)
    return json({ ...session, isGuest: true })
  }

  // 命中：读账号——isGuest 判定与 generate_link 都要用到 admin user 数据
  const u = await serviceRoleFetch(env, `/auth/v1/admin/users/${encodeURIComponent(userId)}`)
  const email = u.data?.email
  if (!u.ok || !email) {
    console.error('[wechat-login] admin user lookup failed:', JSON.stringify(u.data))
    return json({ error: '免登失败，请用邮箱登录' }, 500)
  }

  const pdel = await serviceRoleFetch(
    env,
    `/rest/v1/pending_deletions?user_id=eq.${encodeURIComponent(userId)}&select=reason`,
  )
  if (pdel.data?.length) {
    await serviceRoleFetch(
      env,
      `/rest/v1/pending_deletions?user_id=eq.${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    )
    // 撤位分两种语义（2.3）：guest 清理位静默撤销（人回来就完事，无需打扰）；
    // 注销位撤销发通知邮件（本人可能不记得自己点过注销，静默反而像「注销没生效」）
    const reason = pdel.data[0].reason
    if (reason === 'user_delete') {
      waitUntil(sendNotify(env, { to: email, ...notifyTemplates().cancelRevoked }))
    }
    console.log(`[wechat-login] pending deletion revoked: ${userId} (${reason})`)
  }

  const session = await issueSessionByEmail(env, email)
  if (!session) return json({ error: '免登失败，请用邮箱登录' }, 500)
  return json({ ...session, isGuest: isGuestUser(u.data) })
}
