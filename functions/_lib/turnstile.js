// Turnstile 服务端校验（PRD D4）：人机验证的校验点从 Supabase 迁到 CF 后，
// Web 通道的一次性 captchaToken 在这里消费。TURNSTILE_SECRET_KEY 未配置 =
// 无法验证 = 拒绝（fail-closed）。
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export async function verifyTurnstile(token, env) {
  if (!token || !env.TURNSTILE_SECRET_KEY) return false
  const res = await fetch(SITEVERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token }),
  })
  const data = await res.json().catch(() => null)
  return Boolean(data?.success)
}
