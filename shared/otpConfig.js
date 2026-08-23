// Supabase Dashboard → Authentication → Email 里配置的验证码有效期，目前是 10 分钟。
// 这个值只用于前端"猜测"提示文案（验证码填错 vs 已过期，Supabase 服务端自己都区分
// 不了，见 functions/_lib/supabase.js 的 isOtpInvalidOrExpired），不是权威判断——
// 真正生效的过期时间由 Supabase 服务端自己的逻辑决定，这里只是让提示文案尽量
// 跟那边的配置对齐。以后改了 Supabase 那边的有效期，记得同步改这个值。
export const OTP_TTL_MINUTES = 10
export const OTP_TTL_MS = OTP_TTL_MINUTES * 60 * 1000