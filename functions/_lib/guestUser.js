// D5 访客账号（设计 2.1 / 流程一）：访客 = 真实的 Supabase shadow user。
// email 占位域 / 随机密码 / 强制 confirmed / metadata 标型——业务层与 RLS 对
// 「这个 user_id 是访客还是邮箱账号」零感知（不变量 1），形态信息只存在于
// metadata 与本模块。
import { serviceRoleFetch } from './userAuth.js'

// 全文唯一事实源（v1.5 评审 #2：RFC 2606 保留域，协议级不可投递，
// 不依赖「自建子域不配 MX」这类会被后人误配的运维承诺）。
// createGuestUser 与四个带闸端点的 B9 预检都从这里 import，杜绝两处抄歪。
export const GUEST_EMAIL_DOMAIN = '@guest.invalid'

export function isGuestEmail(email) {
  return typeof email === 'string' && email.toLowerCase().endsWith(GUEST_EMAIL_DOMAIN)
}

// 入参是 GoTrue admin API 返回的 user 对象（含 user_metadata）
export function isGuestUser(gotrueUser) {
  return gotrueUser?.user_metadata?.account_type === 'guest'
}

// Supabase 项目开了强密码策略（四类字符各至少一个），纯 hex 密码必撞
// weak_password 422——2026-09-20 真机首测新访客全被踢回登录页的根因。
// 访客密码无人输入、只当熵源用，四类各取一字符 + 全集合补足后洗牌。
const PWD_CLASSES = [
  'abcdefghijklmnopqrstuvwxyz',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  '0123456789',
  '!@#$%^&*()_+-=[]{};\'\\:"|<>?,./`~',
]

function randomPassword() {
  const all = PWD_CLASSES.join('')
  const pick = (set) => {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    return set[buf[0] % set.length]
  }
  const chars = [...PWD_CLASSES.map(pick), ...Array.from({ length: 28 }, () => pick(all))]
  for (let i = chars.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    const j = buf[0] % (i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

// 未命中 openid → 建访客。顺序（设计 3.3 节拍板）：先建用户、后插映射；
// 映射撞 unique (provider, openid) = 并发双开，对方已建好——删掉我建的、
// 读回赢家的映射继续签发，不报错（用户无感）。
// 返回 { ok: true, userId, email } / { ok: false }（细节只进日志）。
export async function createGuestUser(env, { openid, unionid }) {
  const email = `guest_${crypto.randomUUID()}${GUEST_EMAIL_DOMAIN}`
  const created = await serviceRoleFetch(env, '/auth/v1/admin/users', {
    method: 'POST',
    body: {
      email,
      password: randomPassword(),
      email_confirm: true,
      data: { account_type: 'guest', provider: 'wechat_mp' },
    },
  })
  const userId = created.data?.id
  if (!created.ok || !userId) {
    console.error('[guestUser] admin create failed:', JSON.stringify(created.data))
    return { ok: false }
  }

  const ins = await serviceRoleFetch(env, '/rest/v1/user_identities', {
    method: 'POST',
    body: { user_id: userId, provider: 'wechat_mp', openid, unionid },
  })
  if (ins.ok) return { ok: true, userId, email }

  console.error('[guestUser] identity insert failed, rollback user:', JSON.stringify(ins.data))
  await serviceRoleFetch(env, `/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' })

  const found = await serviceRoleFetch(
    env,
    `/rest/v1/user_identities?select=user_id&provider=eq.wechat_mp&openid=eq.${encodeURIComponent(openid)}`,
  )
  const winnerId = found.data?.[0]?.user_id
  if (!winnerId) return { ok: false }
  const winner = await serviceRoleFetch(env, `/auth/v1/admin/users/${encodeURIComponent(winnerId)}`)
  if (!winner.ok || !winner.data?.email) return { ok: false }
  return { ok: true, userId: winnerId, email: winner.data.email }
}
