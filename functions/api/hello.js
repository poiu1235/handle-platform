import { createRemoteJWKSet, jwtVerify } from 'jose'

// JWKS 端点在项目内基本不变，缓存这个 Set 可以避免每次请求都重新拉取公钥
let jwks

export async function onRequestGet(context) {
  const { request, env } = context

  const authHeader = request.headers.get('Authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (!token) {
    return json({ error: '缺少 Authorization: Bearer <token>' }, 401)
  }

  const supabaseUrl = env.SUPABASE_URL
  if (!supabaseUrl) {
    return json({ error: '服务端未配置 SUPABASE_URL' }, 500)
  }

  try {
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`))
    }

    const { payload } = await jwtVerify(token, jwks, {
      issuer: `${supabaseUrl}/auth/v1`,
      audience: 'authenticated',
    })

    const email = payload.email || payload.user_metadata?.email || '未知用户'

    return json({ message: `hello, ${email}`, userId: payload.sub })
  } catch (err) {
    return json({ error: '登录状态无效或已过期，请重新登录' }, 401)
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
