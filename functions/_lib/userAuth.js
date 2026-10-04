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
export async function serviceRoleFetch(env, path, { method = 'GET', body, prefer } = {}) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  }
  // 🔴 `prefer:'return=representation'` ＝ 让 PostgREST 把**被改到的那些行**回给我们。
  //   不带它时 PATCH 改 0 行与改 1 行回的都是 `200 + 空 body` ⇒ "WHERE 没匹配上"这件事
  //   在代码里长得和"改成功了"一模一样（2026-10-05 真机第一轮就是靠这条区别查出问题的）。
  //   只有"必须真的改到行"的写才加它；加了就要判 `Array.isArray(data) && data.length > 0`。
  if (prefer) options.headers.Prefer = prefer
  // 条件构造而不是 `body: body ? … : undefined`：后者的 `body` 键永远存在，静态判据
  // 读不出 method 的取值，就一直报「GET 不许带 body」。沿用原来的真值判断，行为逐字
  // 不变（现有调用方传的都是对象，或干脆不传）。
  if (body) options.body = JSON.stringify(body)
  const res = await fetch(`${env.SUPABASE_URL}${path}`, options)
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

// 服务端替用户完成一次 magic link 登录（D3 会话签发，R7 spike 定案 2026-09-13：
// verify 必须走 { type:'magiclink', token_hash } 形态，旧形态 { type, token } 会被
// 400 拒绝；全程不出网到邮箱）。wechat-login 命中/建访客两条分支共用
// （scripts/spike-gotrue-session.mjs 为行为依据）。失败返回 null，调用方拼文案。
export async function issueSessionByEmail(env, email) {
  const gl = await serviceRoleFetch(env, '/auth/v1/admin/generate_link', {
    method: 'POST',
    body: { type: 'magiclink', email },
  })
  const tokenHash = gl.data?.properties?.token_hash ?? gl.data?.hashed_token
  if (!gl.ok || !tokenHash) {
    console.error('[userAuth] generate_link failed:', JSON.stringify(gl.data))
    return null
  }

  const vf = await fetch(`${env.SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY },
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
  })
  const session = await vf.json().catch(() => ({}))
  if (!vf.ok || !session.access_token || !session.refresh_token) {
    console.error('[userAuth] verify failed:', JSON.stringify(session).slice(0, 300))
    return null
  }
  return { accessToken: session.access_token, refreshToken: session.refresh_token }
}

// 密码重填 proof（D5 拍板 5，解绑/注销共用）：GoTrue admin API 没有「验密」端点，
// 借 password grant 真登录一次即验证。副作用是 GoTrue 多出一条新会话——解绑路径
// 紧接着 revoke 全部会话会把它一并清掉；注销路径该会话属于本人、冷却期本就允许
// 继续使用，无害。成败只看 res.ok，错误文案不回传。
export async function verifyPasswordProof(env, email, password) {
  if (!email || !password) return false
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  })
  return res.ok
}

// B28 原语：撤销某账号全部会话（refresh 链）。解绑与改密两处共用，失败进日志
// 由人工补——不翻转主业务结果（门已拆/密码已改是主语义）。access token 是无状态
// JWT，撤销后仍有 ≤签发上限（默认 1h）的自然过期残余窗口，设计显式接受。
// GoTrue admin DELETE /users/{id}/sessions 的可用性列入冒烟清单（同 R7 教训）。
export async function revokeAllSessions(env, userId) {
  const res = await serviceRoleFetch(
    env,
    `/auth/v1/admin/users/${encodeURIComponent(userId)}/sessions`,
    { method: 'DELETE' },
  )
  if (!res.ok) console.error('[userAuth] revoke sessions failed:', userId, JSON.stringify(res.data))
  return res.ok
}
