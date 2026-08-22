import { createRemoteJWKSet, jwtVerify } from 'jose'
import { json } from '../_lib/supabase.js'

// _middleware.js 放在 functions/api/ 目录下，只对 /api/* 生效，
// 不会影响 /auth/* 下那些本来就该公开访问的注册/登录/验证码接口。

let jwks
let jwksSupabaseUrl

function getJwks(supabaseUrl) {
  if (!jwks || jwksSupabaseUrl !== supabaseUrl) {
    jwks = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`))
    jwksSupabaseUrl = supabaseUrl
  }
  return jwks
}

function isRecoverySession(payload) {
  const amr = payload.amr
  if (!Array.isArray(amr) || amr.length === 0) return false
  return amr[amr.length - 1]?.method === 'recovery'
}

export async function onRequest(context) {
  const { request, env, next } = context
  const supabaseUrl = env.SUPABASE_URL
  if (!supabaseUrl) return json({ error: '服务端未配置 SUPABASE_URL' }, 500)

  const authHeader = request.headers.get('Authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  // no session → 401
  if (!token) return json({ error: '未登录' }, 401)

  let payload
  try {
    const result = await jwtVerify(token, getJwks(supabaseUrl), {
      issuer: `${supabaseUrl}/auth/v1`,
      audience: 'authenticated',
    })
    payload = result.payload
  } catch {
    return json({ error: '登录状态无效或已过期，请重新登录' }, 401)
  }

  // recovery → 403
  // 按当前架构，恢复流程（verify-recovery）根本不会把 Supabase session 下发到浏览器，
  // 前端合法拿到的 access token 理论上不会是 recovery 态；这里保留检查是纵深防御——
  // 万一将来哪个路径又不小心把 recovery session 泄漏到了客户端，这里依然能拦住，
  // 不是唯一防线，但绝不因为"理论上不会发生"就省掉。
  if (isRecoverySession(payload)) {
    return json({ error: '当前登录状态仅可用于重置密码，无法访问业务数据' }, 403)
  }

  // authenticated → continue
  context.data.user = { id: payload.sub, email: payload.email }
  context.data.accessToken = token

  return next()
}