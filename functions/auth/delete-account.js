import { json } from '../_lib/supabase.js'
import { verifyUserBearer, serviceRoleFetch, verifyPasswordProof } from '../_lib/userAuth.js'
import { rateGuard } from '../_lib/authGate.js'
import { isGuestUser } from '../_lib/guestUser.js'

// D5 B15：注销 = 删除流水线的入队动作（2.3，reason=user_delete），不是立即删除。
// 置无效位 + 7 天冷却：期间重新登录 / openid 免登 = 本人撤销（login.js 与
// wechat-login.js 已实现撤位通道），到期由 pg_cron 物理清（删 auth.users 一行
// 级联清光业务数据 + identity + token，purge 时刻写 deletion_purges 留痕）。
//
// proof 分流（v1.2 拍板 5 / B15）：
//   邮箱账号 → 密码重填（与解绑同款）；
//   访客     → 会话本身 + 小程序端二次确认弹窗。访客无密码体系，「能在微信里
//              建立并持有该会话」就是其全部凭证强度（1.3：借微信端环境）。
//
// 冷却期内会话不打断——「继续可用直到反悔期结束」是设计的一部分（2.3），
// 所以本端点不做 revoke（与解绑的关键差异，那边是紧急拆门要踢人）。
const COOLDOWN_DAYS = 7

export async function onRequestPost(context) {
  const { request, env } = context
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: '服务端未配置 SUPABASE_SERVICE_ROLE_KEY' }, 500)

  const user = await verifyUserBearer(request, env)
  if (!user) return json({ error: '登录状态无效或已过期，请重新登录' }, 401)

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  if (rateGuard(`delete-account:${ip}`)) return json({ error: '尝试过于频繁，请稍后再试' }, 429)

  const q = encodeURIComponent(user.userId)
  const u = await serviceRoleFetch(env, `/auth/v1/admin/users/${q}`)
  if (!u.ok) {
    console.error('[delete-account] admin lookup failed:', JSON.stringify(u.data))
    return json({ error: '服务端异常，请稍后再试' }, 500)
  }
  const guest = isGuestUser(u.data)

  if (!guest) {
    const { password } = await request.json().catch(() => ({}))
    if (!(await verifyPasswordProof(env, user.email, password))) {
      return json({ error: '密码不正确', code: 'proof_failed' }, 403)
    }
  }

  // 幂等：已置位（含被 B10 清理任务置位的情况）→ 原样返回现状，不刷新冷却
  const existing = await serviceRoleFetch(env, `/rest/v1/pending_deletions?user_id=eq.${q}&select=reason,purge_after`)
  if (existing.data?.length) {
    return json({ scheduled: true, reason: existing.data[0].reason, purgeAfter: existing.data[0].purge_after })
  }

  const purgeAfter = new Date(Date.now() + COOLDOWN_DAYS * 86_400_000).toISOString()
  const ins = await serviceRoleFetch(env, '/rest/v1/pending_deletions', {
    method: 'POST',
    body: { user_id: user.userId, reason: 'user_delete', purge_after: purgeAfter },
  })
  if (!ins.ok) {
    // 撞 primary key = 并发双提交，读回现状即幂等成功
    const again = await serviceRoleFetch(env, `/rest/v1/pending_deletions?user_id=eq.${q}&select=reason,purge_after`)
    if (again.data?.length) {
      return json({ scheduled: true, reason: again.data[0].reason, purgeAfter: again.data[0].purge_after })
    }
    console.error('[delete-account] mark failed:', JSON.stringify(ins.data))
    return json({ error: '注销申请失败，请稍后重试' }, 502)
  }

  // 邮箱账号注销后其 identity 行随 purge 级联删除——该 openid 下次冷启动
  // 走未命中分支自动新建空访客（B15 备注语义），无需在此处处理。
  // 反悔期通知邮件待发信通道定案，当前仅 CF 日志。
  console.log(`[delete-account] ${user.userId} (${guest ? 'guest' : 'email'}) scheduled for purge at ${purgeAfter}`)
  return json({ scheduled: true, reason: 'user_delete', purgeAfter })
}
