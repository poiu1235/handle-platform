import { json, translateSupabaseError } from '../_lib/supabase.js'
import { authGate } from '../_lib/authGate.js'
import { serviceRoleFetch } from '../_lib/userAuth.js'

export async function onRequestPost(context) {
  const { request, env } = context
  // 认证闸门（D4）：mp 通道验 wxLoginCode、Web 通道验 Turnstile，未过闸不触达 Supabase
  const gate = await authGate(request, env)
  if (!gate.pass) return gate.response
  const { email, password, captchaToken } = await request.json().catch(() => ({}))
  if (!email || !password) return json({ error: '缺少邮箱或密码' }, 400)

  // 登录后微信身份一致性检查（仅 mp 通道）：gate.openid 只有在这次请求带了
  // wxLoginCode（即小程序端）才会有值，Web 通道走 Turnstile，gate.openid 恒为
  // undefined，天然跳过——网页/其他端允许手动登录，不做微信身份绑定校验，
  // 只有小程序才用 openid 反查约束。fail-closed：这条检查要用到的 key 缺失时
  // 直接拒绝，不降级放行（与 wechat-bind.js 同一口径）。
  if (gate.openid && !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: '服务端未配置 SUPABASE_SERVICE_ROLE_KEY' }, 500)
  }

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY },
    body: JSON.stringify({
      email,
      password,
      gotrue_meta_security: captchaToken ? { captcha_token: captchaToken } : undefined,
    }),
  })
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
      return json(
        { error: '该邮箱数据仅允许通过已绑定的微信查看，请使用绑定时的微信重新登录', code: 'wechat_identity_mismatch' },
        403,
      )
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

  return json({ accessToken: data.access_token, refreshToken: data.refresh_token })
}