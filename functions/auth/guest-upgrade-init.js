import { json } from '../_lib/supabase.js'
import { verifyUserBearer, serviceRoleFetch } from '../_lib/userAuth.js'
import { issueUpgradeTicket, TICKET_TTL_SECONDS } from '../_lib/upgradeTicket.js'
import { rateGuard } from '../_lib/authGate.js'
import { isGuestUser } from '../_lib/guestUser.js'

// D5 5.2-①：访客会话发起邮箱绑定，换一张一次性 upgradeTicket。
// 门禁 = 访客 Bearer 本身；ticket 只进客户端内存（对齐 resetTicket 纪律，
// PRD 6.3.4-6），15 分钟时效，冷启动丢失 = 重新 init（幂等，B4/失败语义）。
// 下一步用户去现成的注册/登录页走流程（端点零改动），拿目标会话来 confirm。
export async function onRequestPost(context) {
  const { request, env } = context
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: '服务端未配置 SUPABASE_SERVICE_ROLE_KEY' }, 500)

  const user = await verifyUserBearer(request, env)
  if (!user) return json({ error: '登录状态无效或已过期，请重新登录' }, 401)

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  if (rateGuard(`upgrade-init:${ip}`)) return json({ error: '尝试过于频繁，请稍后再试' }, 429)

  const u = await serviceRoleFetch(env, `/auth/v1/admin/users/${encodeURIComponent(user.userId)}`)
  if (!u.ok) {
    console.error('[guest-upgrade-init] admin lookup failed:', JSON.stringify(u.data))
    return json({ error: '服务端异常，请稍后再试' }, 500)
  }
  // B2：邮箱账号→邮箱账号永互斥，访客→邮箱只此单向
  if (!isGuestUser(u.data)) {
    return json({ error: '当前账号不是访客账号', code: 'not_guest' }, 400)
  }
  // 2.3：清理/注销置位期内的账号不做升级中转
  const pdel = await serviceRoleFetch(
    env,
    `/rest/v1/pending_deletions?user_id=eq.${encodeURIComponent(user.userId)}&select=reason`,
  )
  if (pdel.data?.length) {
    return json({ error: '账号正在注销或清理流程中，暂不可操作', code: 'deletion_pending' }, 409)
  }

  const provider = u.data.user_metadata?.provider || 'wechat_mp'
  const ticket = await issueUpgradeTicket(env, { guestUserId: user.userId, provider })
  return json({ ticket, expiresIn: TICKET_TTL_SECONDS })
}
