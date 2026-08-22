// 密码复杂度规则。前端（Register.jsx / ResetPassword.jsx）、Cloudflare Worker
// （functions/auth/register.js、reset-password.js）都从这里 import 同一份实现，
// 不是"前端拦一道、服务端随便兜底"——这里的规则和 Worker 里的校验才是真正生效的防线，
// Supabase Dashboard 里的密码策略只是保持同步、不作为唯一依赖。
// 纯函数、不依赖 DOM/浏览器 API，也不依赖 Cloudflare Workers 特有 API，两边都能直接用。

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/

export function isPasswordValid(password) {
  return PASSWORD_REGEX.test(password)
}

export function passwordHint() {
  return '密码至少 8 位，需同时包含大写字母、小写字母、数字和符号'
}