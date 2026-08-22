import { SignJWT, jwtVerify } from 'jose'

// 关键设计：这是 Cloudflare 自己签发、自己校验的票据，跟 Supabase 签发的登录 JWT
// 不共享签名体系（这里是 HS256 + Cloudflare 私有 secret，Supabase 那边是 RS256/ES256
// + Supabase 自己的 JWKS）。任何只认 Supabase JWKS 的地方（比如 functions/api/_middleware.js）
// 天然无法把这张票据当成登录态使用——不是靠一个 amr 字段的君子协定，而是结构上就是
// 两种不同的令牌。这就是"重置的 token 要与登录的 token 区分开"的落地方式。
const ALG = 'HS256'
const TICKET_TTL_SECONDS = 5 * 60 // 5分钟，只够走完"验证码→设置新密码"这一次提交

function getSecretKey(env) {
  if (!env.RESET_TICKET_SECRET) {
    throw new Error('服务端未配置 RESET_TICKET_SECRET')
  }
  return new TextEncoder().encode(env.RESET_TICKET_SECRET)
}

export async function issueResetTicket(env, { userId, email }) {
  return new SignJWT({ purpose: 'password_reset', email })
    .setProtectedHeader({ alg: ALG })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${TICKET_TTL_SECONDS}s`)
    .sign(getSecretKey(env))
}

export async function verifyResetTicket(env, ticket) {
  const { payload } = await jwtVerify(ticket, getSecretKey(env))
  if (payload.purpose !== 'password_reset') {
    throw new Error('invalid ticket purpose')
  }
  return payload // { sub: userId, email, iat, exp, purpose }
}