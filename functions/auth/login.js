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
    // 密码已验证通过，现在拿真实 user_id 去查这个账号是否已绑定微信身份。
    // 只关心「这个账号自己的绑定关系」是否跟本次登录带来的 openid 冲突——
    // 冲突就是别的微信在冒用这个邮箱账号登录，拒绝登录，不下发 token。
    // 账号还没绑过微信（row 不存在）不算冲突，走正常登录，绑定在登录成功后
    // 由客户端静默调用 /wechat-bind 完成（D3 3.3.4）。
    const bound = await serviceRoleFetch(
      env,
      `/rest/v1/user_identities?select=openid&provider=eq.wechat_mp&user_id=eq.${encodeURIComponent(data.user?.id)}`,
    )
    const row = bound.data?.[0]
    if (row && row.openid !== gate.openid) {
      return json(
        { error: '该邮箱数据仅允许通过已绑定的微信查看，请使用绑定时的微信重新登录', code: 'wechat_identity_mismatch' },
        403,
      )
    }
  }

  return json({ accessToken: data.access_token, refreshToken: data.refresh_token })
}