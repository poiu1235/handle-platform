import { json, translateSupabaseError } from '../_lib/supabase.js'
import { authGate } from '../_lib/authGate.js'
import { serviceRoleFetch } from '../_lib/userAuth.js'
import { isGuestEmail, isGuestUser } from '../_lib/guestUser.js'
import { sendNotify, notifyTemplates } from '../_lib/mailer.js'

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context
  // 认证闸门（D4）：mp 通道验 wxLoginCode、Web 通道验 Turnstile，未过闸不触达 Supabase
  const gate = await authGate(request, env)
  if (!gate.pass) return gate.response
  const { email, password, captchaToken } = await request.json().catch(() => ({}))
  if (!email || !password) return json({ error: '缺少邮箱或密码' }, 400)
  // B9：访客占位邮箱不是可登录身份（随机密码本来就登不进，这里给可读文案 +
  // 省一次注定失败的 Supabase 请求）
  if (isGuestEmail(email)) {
    return json({ error: '这是微信访客账号，请在微信内直接打开使用或绑定邮箱', code: 'guest_account' }, 400)
  }

  // 登录后微信身份一致性检查（仅 mp 通道）：gate.openid 只有在这次请求带了
  // wxLoginCode（即小程序端）才会有值，Web 通道走 Turnstile，gate.openid 恒为
  // undefined，天然跳过——网页/其他端允许手动登录，不做微信身份绑定校验，
  // 只有小程序才用 openid 反查约束。fail-closed：这条检查要用到的 key 缺失时
  // 直接拒绝，不降级放行（与 wechat-bind.js 同一口径）。
  if (gate.openid && !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: '服务端未配置 SUPABASE_SERVICE_ROLE_KEY' }, 500)
  }

  // 连不上认证服务与「密码错」是两回事：Supabase 回 4xx 才是凭证不对（走下面的
  // translateSupabaseError）。这里单独给 503，别伪装成登录失败让人反复试密码。
  // 异常本身不在这里记日志——functions/_middleware.js 的边界会记 path + reference，
  // 站点级 catch 能看到的也只有那个被 workerd 替换过的错误。
  let res
  try {
    res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY },
      body: JSON.stringify({
        email,
        password,
        gotrue_meta_security: captchaToken ? { captcha_token: captchaToken } : undefined,
      }),
    })
  } catch {
    return json({ error: '认证服务暂时连不上，请稍后再试', code: 'upstream_unreachable' }, 503)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return json({ error: translateSupabaseError(data) }, res.status)

  if (gate.openid) {
    // 密码已验证通过，现在拿真实 user_id 去查微信身份冲突。两个方向都要查，
    // 缺一个都会漏放：
    //   1) byOpenid：这次登录带来的 openid 是不是已经绑在别的账号上
    //      （典型场景：同一台设备/微信身份先绑定过 A 账号，退出后又登录 B 账号——
    //      B 账号自己没有绑定记录，只查「B 有没有绑过别的 openid」是查不出这种
    //      冲突的，必须反过来查「这个 openid 已经绑给谁了」）
    //   2) byUser：当前账号是不是已经绑过别的 openid
    // 任一方向命中冲突就拒绝登录、不下发 token——不能指望登录成功后
    // wechat-bind 的 409 来兜底，那时 session 已经放出去了，为时已晚。
    const table = '/rest/v1/user_identities'
    const base = `${table}?select=user_id,openid&provider=eq.wechat_mp`

    const byOpenid = await serviceRoleFetch(env, `${base}&openid=eq.${encodeURIComponent(gate.openid)}`)
    const openidRow = byOpenid.data?.[0]
    if (openidRow && openidRow.user_id !== data.user?.id) {
      // D5 5.5：冲突方是访客账号 → 放行。访客态下小程序的邮箱入口本来就是
      // 绑定流程的载体，这次登录是 5.2 的②步而非冲突——openid 的钥匙还留在
      // 访客名下，稍后由 guest-upgrade-confirm 原子搬过来。这里 403 会把
      // 绑定流程结构性堵死（用户永远进不了目标账号）。
      // 冲突方是别的邮箱账号 → 维持 wechat_identity_mismatch 拒绝（D3 原语义）。
      const owner = await serviceRoleFetch(
        env,
        `/auth/v1/admin/users/${encodeURIComponent(openidRow.user_id)}`,
      )
      if (!isGuestUser(owner.data)) {
        return json(
          { error: '该邮箱数据仅允许通过已绑定的微信查看，请使用绑定时的微信重新登录', code: 'wechat_identity_mismatch' },
          403,
        )
      }
    }

    const byUser = await serviceRoleFetch(env, `${base}&user_id=eq.${encodeURIComponent(data.user?.id)}`)
    const userRow = byUser.data?.[0]
    if (userRow && userRow.openid !== gate.openid) {
      return json(
        { error: '该邮箱数据仅允许通过已绑定的微信查看，请使用绑定时的微信重新登录', code: 'wechat_identity_mismatch' },
        403,
      )
    }
  }

  // 2.3 登录即撤位：注销冷却期内重新登录 = 本人撤销注销（与 wechat-login 的
  // 免登撤位同一语义 + 同一通知策略：撤位 DB 即时生效，通知 fire-and-forget）
  if (data.user?.id) {
    const pdel = await serviceRoleFetch(
      env,
      `/rest/v1/pending_deletions?user_id=eq.${encodeURIComponent(data.user.id)}&select=reason`,
    )
    if (pdel.data?.length) {
      await serviceRoleFetch(
        env,
        `/rest/v1/pending_deletions?user_id=eq.${encodeURIComponent(data.user.id)}`,
        { method: 'DELETE' },
      )
      if (pdel.data[0].reason === 'user_delete') {
        waitUntil(sendNotify(env, { to: data.user.email, ...notifyTemplates().cancelRevoked }))
      }
      console.log(`[login] pending deletion revoked: ${data.user.id} (${pdel.data[0].reason})`)
    }
  }

  return json({ accessToken: data.access_token, refreshToken: data.refresh_token })
}