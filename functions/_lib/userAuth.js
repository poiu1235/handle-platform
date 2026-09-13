// /auth/* 下需要「用户身份」的端点共用的校验工具。
// verifyUserBearer 与 functions/api/_middleware.js 是同一套 JWKS 语义（jose + issuer/audience）；
// 中间件本体保持零改动（PRD 6.1），这里只为新增端点抽出可复用的实现。
// serviceRoleFetch 收敛服务端特权调用（user_identities 读写 / GoTrue Admin API）。
import { createRemoteJWKSet, jwtVerify } from 'jose'

let jwks
let jwksSupabaseUrl

function getJwks(supabaseUrl) {
  if (!jwks || jwksSupabaseUrl !== supabaseUrl) {
    jwks = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`))
    jwksSupabaseUrl = supabaseUrl
  }
  return jwks
}

// 校验 Authorization: Bearer <用户 access token>。
// 返回 { userId, email }；无 token / 验签失败 / 非 authenticated 会话一律返回 null，
// 响应由调用方自行拼（不同端点文案不同）。
export async function verifyUserBearer(request, env) {
  const authHeader = request.headers.get('Authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token || !env.SUPABASE_URL) return null
  try {
    const result = await jwtVerify(token, getJwks(env.SUPABASE_URL), {
      issuer: `${env.SUPABASE_URL}/auth/v1`,
      audience: 'authenticated',
    })
    return { userId: result.payload.sub, email: result.payload.email }
  } catch {
    return null
  }
}

// service_role 调 Supabase REST / Admin API（绝不进客户端、不进日志）。
// 返回 { ok, status, data }，语义同 _lib/supabase.js 的 supabaseAuthFetch。
export async function serviceRoleFetch(env, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}
