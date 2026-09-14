// 认证闸门（PRD D4 分通道人机验证）：register / resend-signup / login / forgot-password
// 四个端点在触达 Supabase 之前统一过闸。
//
// 通道判定凭「能验证的凭证种类」，不凭客户端自报字段：带 wxLoginCode → mp 通道，
// 现场 code2session 验真；否则 → Web 通道，captchaToken 必填且 siteverify 通过。
// 两条路径都是硬性关卡——没有「什么都不带也能过」的第三条路，验真失败也不降级放行。
// 400 文案沿用 translateSupabaseError 对 captcha 的既有翻译（「人机验证未通过，请重试」），
// Web 前端展示的文案与校验点迁移前一字不差（零改动）。
//
// ⚠️ 依赖约束：本闸门上线的前提是 Supabase Captcha 已关闭。Turnstile token 是一次性
// 凭证，siteverify 消费后，开着的 Supabase Captcha 会因 token 已被消费而再次拒绝——
// 两层不能同时强校验。若日后重开 Supabase Captcha，必须先摘掉 Web 通道的 siteverify 分支。
import { json } from './supabase.js'
import { verifyTurnstile } from './turnstile.js'
import { code2session } from './wxTicket.js'

// 频控兜底（PRD 6.1-8 占位实）：实例级内存窗口，同一 IP 60 秒内最多 5 次。
// 每个 isolate 各自计数（实际阈值 = 配置值 × 并发 isolate 数），只求把 authGate
// 万一被绕过时的最坏情况挡在门外，不上强度。
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_BUCKETS_MAX = 10_000
const rateBuckets = new Map()

function isRateLimited(key, now = Date.now()) {
  const bucket = rateBuckets.get(key)
  if (!bucket || now - bucket.start >= RATE_LIMIT_WINDOW_MS) {
    if (rateBuckets.size >= RATE_BUCKETS_MAX) {
      for (const [k, b] of rateBuckets) {
        if (now - b.start >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(k)
      }
    }
    rateBuckets.set(key, { start: now, count: 1 })
    return false
  }
  bucket.count += 1
  return bucket.count > RATE_LIMIT_MAX
}

export async function authGate(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  if (isRateLimited(`auth:${ip}`)) {
    return { pass: false, response: json({ error: '尝试过于频繁，请稍后再试' }, 429) }
  }

  const body = await request.clone().json().catch(() => ({}))

  if (body.wxLoginCode) {
    const r = await code2session(body.wxLoginCode, env)
    if (!r.ok) {
      // errcode 直接带回去（40013=appid 不符 / 40125=secret 错 / 40029=code 无效或已用 / 40164=IP 白名单），
      // 排障从冒烟日志一步到位；errmsg 只进 CF 日志，不回传客户端
      return {
        pass: false,
        response: json({ error: `微信身份校验失败（errcode: ${r.errcode}）`, code: 'wx_ticket_invalid' }, 400),
      }
    }
    // openid/unionid 一并带出去：code2session 换过一次的一次性 code 已经消费掉了，
    // 调用方（login.js 的登录后微信身份冲突检查）不能再换第二次，只能复用这里的结果
    return { pass: true, openid: r.openid, unionid: r.unionid }
  }

  if (!body.captchaToken) {
    return { pass: false, response: json({ error: '人机验证未通过，请重试' }, 400) }
  }
  const verified = await verifyTurnstile(body.captchaToken, env)
  if (!verified) {
    return { pass: false, response: json({ error: '人机验证未通过，请重试' }, 400) }
  }
  return { pass: true }
}