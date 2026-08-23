// 所有 functions/auth/* 和 functions/api/* 共用的小工具。
// 文件名以 _ 开头，Cloudflare Pages Functions 不会把它当路由，只当普通可 import 的模块。

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// 用 anon key 调用 Supabase Auth 的 POST 类端点（/verify /signup /recover /resend 等），
// 统一处理 apikey 头和 JSON 解析，返回 {ok, status, data} 而不是直接 throw，
// 方便调用方按业务语义决定要不要把错误翻译给用户。
export async function supabaseAuthFetch(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

// 与之前 Login.jsx 里 translateError() 同源，现在挪到服务端统一翻译——
// 前端页面不用再各自维护一份关键词映射表，直接展示 data.error 即可。
const ERROR_MAP = {
  'Invalid login credentials': '邮箱或密码不正确',
  'User already registered': '该邮箱已经注册过了，直接登录即可',
  'Email not confirmed': '邮箱还未验证，请先完成验证码验证',
  'captcha protection: request disallowed': '人机验证未通过，请重试',
  'Token has expired or is invalid': '验证码错误或已过期，请重新获取',
}

function extractMessage(data) {
  return data?.error_description || data?.msg || data?.error || data?.error_code || '请求失败'
}

// Supabase 对"验证码填错"和"验证码已过期"这两种情况，返回的是同一个
// error_code: otp_expired / 同一句 "Token has expired or is invalid"——服务端
// 自己就没有信号能把这两种情况区分开（这是 GoTrue 故意这么设计的，避免给暴力
// 猜验证码的人多一条"猜得有多接近"的信息）。这里只能识别出"是不是这一整类
// 含糊错误"，真正区分交给前端按验证码发送时间做一个尽力而为的猜测——见
// functions/auth/verify-signup.js、verify-recovery.js 和前端 Register.jsx / ForgotPassword.jsx
export function isOtpInvalidOrExpired(data) {
  if (data?.error_code === 'otp_expired') return true
  const message = extractMessage(data)
  return /(token|otp|code)/i.test(message) && /(expired|invalid)/i.test(message)
}

export function translateSupabaseError(data) {
  const message = extractMessage(data)

  if (ERROR_MAP[message]) return ERROR_MAP[message]

  if (/password/i.test(message) && /(character|characters|weak|contain|strong)/i.test(message)) {
    return '密码需至少8位，且包含大小写字母、数字和符号'
  }
  if (/security purposes|only request|rate limit/i.test(message)) {
    return '请求过于频繁，请稍后再试'
  }
  if (isOtpInvalidOrExpired(data)) {
    return '验证码错误或已过期，请重新获取'
  }

  return message
}