import { json } from '../_lib/supabase.js'
import { verifyUserBearer, serviceRoleFetch, verifyPasswordProof, revokeAllSessions } from '../_lib/userAuth.js'
import { rateGuard } from '../_lib/authGate.js'
import { isGuestUser } from '../_lib/guestUser.js'
import { sendNotify, notifyTemplates } from '../_lib/mailer.js'

// D5 7.2：解绑。proof = 当场重填密码（v1.2 拍板 5：操作全在微信客户端内，
// 变相借微信风控，密码重填已够）。被偷会话者不知道密码 → 拆不掉门（B21）。
//
// 生效链条（顺序即防呆：最便宜的拒绝放最前）：
//   Bearer → provider 白名单 → 有绑定记录 → 非访客（7.4）→ 非置位账号（2.3）
//   → churn 阈值（B25）→ 密码 proof → 删行 → 记流水 → revoke 全部会话（B28）。
//
// B28：解绑后撤销该账号全部 refresh 会话——含操作者自己（客户端据此引导重新登录）
// 和被盗/共享设备上经免登建立的会话。残余 = access token ≤1h 无状态窗口，显式接受。
// 通知邮件（7.2 定案项）待发信通道选型，现阶段 revoke + CF 日志兜底。
const PROVIDERS = ['wechat_mp'] // 本期唯一启用的 provider（v1.2 拍板 4）
const CHURN_WINDOW_DAYS = 30
const CHURN_MAX = 3 // B25：每 identity 30 天解绑+绑定合计 ≤3 次

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: '服务端未配置 SUPABASE_SERVICE_ROLE_KEY' }, 500)

  const user = await verifyUserBearer(request, env)
  if (!user) return json({ error: '登录状态无效或已过期，请重新登录' }, 401)

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  if (rateGuard(`unbind:${ip}`)) return json({ error: '尝试过于频繁，请稍后再试' }, 429)

  const { provider, password } = await request.json().catch(() => ({}))
  if (!PROVIDERS.includes(provider)) return json({ error: '不支持的身份类型', code: 'bad_provider' }, 400)

  const q = encodeURIComponent(user.userId)
  const rows = await serviceRoleFetch(
    env,
    `/rest/v1/user_identities?select=id&user_id=eq.${q}&provider=eq.${encodeURIComponent(provider)}`,
  )
  if (!rows.data?.length) {
    // 无绑定可拆 = 幂等语义上的「已经是解绑态」，但为了让客户端区分「操作成功」
    // 与「状态本就如此」，给明确码而不是伪装 unbound
    return json({ error: '当前账号未绑定该身份', code: 'not_bound' }, 404)
  }

  const u = await serviceRoleFetch(env, `/auth/v1/admin/users/${q}`)
  if (!u.ok) {
    console.error('[identity-unbind] admin lookup failed:', JSON.stringify(u.data))
    return json({ error: '服务端异常，请稍后再试' }, 500)
  }
  if (isGuestUser(u.data)) {
    // 7.4：访客唯一身份解绑 = 账号自灭，语义不归解绑归注销
    return json({ error: '访客账号没有解绑概念，如需清空数据请使用注销', code: 'guest_account' }, 400)
  }
  const pdel = await serviceRoleFetch(env, `/rest/v1/pending_deletions?user_id=eq.${q}&select=reason`)
  if (pdel.data?.length) {
    return json({ error: '账号正在注销或清理流程中，暂不可操作', code: 'deletion_pending' }, 409)
  }

  // B25 churn 计数：绑定次数数 account_merges（合并即绑，含访客升级），
  // 解绑次数数 identity_unbinds（d5-unbind-churn.sql 增量迁移的流水）。
  // 静默 wechat-bind 的首绑不计入——正常首绑不是 churn，被计数的闭环是
  // 「unbind+upgrade 循环」，已经完整覆盖滥用面。
  const since = new Date(Date.now() - CHURN_WINDOW_DAYS * 86_400_000).toISOString()
  const [merges, unbinds] = await Promise.all([
    serviceRoleFetch(env, `/rest/v1/account_merges?select=id&target_id=eq.${q}&provider=eq.${encodeURIComponent(provider)}&created_at=gt.${since}`),
    serviceRoleFetch(env, `/rest/v1/identity_unbinds?select=id&user_id=eq.${q}&provider=eq.${encodeURIComponent(provider)}&unbound_at=gt.${since}`),
  ])
  if ((merges.data?.length ?? 0) + (unbinds.data?.length ?? 0) >= CHURN_MAX) {
    return json({ error: '30 天内绑定关系变更已达上限，请过段时间再操作', code: 'rate_limited' }, 429)
  }

  // proof 放在所有只读检查之后：只有「确实要拆门」的请求才触达密码通道
  if (!(await verifyPasswordProof(env, user.email, password))) {
    return json({ error: '密码不正确', code: 'proof_failed' }, 403)
  }

  const del = await serviceRoleFetch(
    env,
    `/rest/v1/user_identities?user_id=eq.${q}&provider=eq.${encodeURIComponent(provider)}`,
    { method: 'DELETE' },
  )
  if (!del.ok) {
    console.error('[identity-unbind] delete failed:', JSON.stringify(del.data))
    return json({ error: '解绑失败，请稍后重试' }, 502)
  }
  await serviceRoleFetch(env, '/rest/v1/identity_unbinds', {
    method: 'POST',
    body: { user_id: user.userId, provider },
  })

  // B28 联动撤销（原语在 userAuth.revokeAllSessions，与改密路径共用）：
  // 失败不翻转解绑结果（门已拆是主语义），进日志人工补
  const revoked = await revokeAllSessions(env, user.userId)

  // 解绑通知（7.2 定案项）：fire-and-forget，成败不影响响应
  waitUntil(sendNotify(env, { to: user.email, ...notifyTemplates('微信').unbound }))

  console.log(`[identity-unbind] ${user.userId} unbound ${provider}; sessionsRevoked=${revoked}`)
  return json({ unbound: true, sessionsRevoked: revoked })
}
