// D5 访客升级票据（设计 5.2）：绑定流程 init → 注册/登录 → confirm 的跨会话黏合剂。
// 与 resetTicket.js 同款结构：CF 自己 HS256 签验，跟 Supabase 登录 JWT 不共享签名
// 体系——结构上就不可能被任何认 JWKS 的地方当成登录态。
//
// 一次性消费不落表：merge_guest 的行锁 + not_guest 校验（评审 #3/#4）使第二次
// confirm 必然失败，「已消费」由数据库不变式保证，不需要额外状态。15 分钟时效
// 即票据泄露-重放的全部敞口（B8 口径；消费方还必须是刚完成强凭证验证的会话）。
import { SignJWT, jwtVerify } from 'jose'

const ALG = 'HS256'
const TICKET_TTL_SECONDS = 15 * 60

function getSecretKey(env) {
  if (!env.UPGRADE_TICKET_SECRET) {
    throw new Error('服务端未配置 UPGRADE_TICKET_SECRET')
  }
  return new TextEncoder().encode(env.UPGRADE_TICKET_SECRET)
}

export async function issueUpgradeTicket(env, { guestUserId, provider }) {
  return new SignJWT({ purpose: 'guest_upgrade', provider })
    .setProtectedHeader({ alg: ALG })
    .setSubject(guestUserId)
    .setIssuedAt()
    .setExpirationTime(`${TICKET_TTL_SECONDS}s`)
    .sign(getSecretKey(env))
}

export async function verifyUpgradeTicket(env, ticket) {
  const { payload } = await jwtVerify(ticket, getSecretKey(env))
  if (payload.purpose !== 'guest_upgrade') {
    throw new Error('invalid ticket purpose')
  }
  return payload // { sub: guestUserId, provider, iat, exp, purpose }
}

export { TICKET_TTL_SECONDS }
