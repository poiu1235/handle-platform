// Turnstile 服务端校验（PRD D4）：人机验证的校验点从 Supabase 迁到 CF 后，
// Web 通道的一次性 captchaToken 在这里消费。
//
// 三态返回，不合并成布尔：`false` 与"连不上校验服务"是两件不同的事，压成一个
// false 会让 CF 故障时给用户回「人机验证未通过，请重试」，用户于是反复重填一个
// 本来就过了的验证码。判据只能来自"我们主动连的是谁"——workerd 在异常进入任何
// 用户代码之前就把错误换成了 `internal error; reference = …`（cause 为 undefined，
// 2026-10-02 实测），所以 catch 里读不到真因，只能就地定性。
//
// 三态都是 fail-closed：任何一态都不会放行请求，只有 true 过闸。区别只在文案与
// 状态码（见 authGate）。
import { json } from './supabase.js'

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

// verifyTurnstile 的第三态；authGate 用同一个常量比对，别写字符串字面量
export const TURNSTILE_UNAVAILABLE = 'unavailable'

// 返回 true（验过）/ false（没验过，用户侧问题）/ TURNSTILE_UNAVAILABLE
// （服务端连不上或没配 key，与用户无关）
export async function verifyTurnstile(token, env) {
  // 没配 secret = 我们无法验证，不是用户没过验证码（本地 .dev.vars 落后于
  // .dev.vars.example 就是这个形态，给 503 才指得向真因）
  if (!env.TURNSTILE_SECRET_KEY) return TURNSTILE_UNAVAILABLE
  if (!token) return false

  let res
  try {
    res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token }),
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    return TURNSTILE_UNAVAILABLE
  }

  // siteverify 对「验证不通过」回 200 + success:false；非 200 是请求本身被拒
  // （secret 不配对、参数缺失），属于服务端问题，不该算在用户头上
  if (!res.ok) return TURNSTILE_UNAVAILABLE
  const data = await res.json().catch(() => null)
  if (!data) return TURNSTILE_UNAVAILABLE
  return Boolean(data.success)
}

// authGate 用：第三态的统一响应。文案刻意不提"重试验证码"。
export function turnstileUnavailableResponse() {
  return json({ error: '人机验证服务暂时不可用，请稍后再试', code: 'captcha_unavailable' }, 503)
}
