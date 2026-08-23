// accessToken 只放内存（不落 localStorage，减少 XSS 场景下的暴露面）；
// refreshToken 落 localStorage 用于刷新页面后免登录。resetTicket 完全不经过这里，
// 由 AuthContext 自己在内存里持有（见 AuthContext.jsx）。
let accessToken = null
let refreshToken = null

function decodeJwtPayload(token) {
  try {
    const [, payload] = token.split('.')
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
    return JSON.parse(atob(padded))
  } catch {
    return null
  }
}

function applySession(data) {
  accessToken = data.accessToken
  refreshToken = data.refreshToken
  localStorage.setItem('refreshToken', refreshToken)
  const payload = decodeJwtPayload(accessToken)
  return { user: { id: payload?.sub, email: payload?.email } }
}

function clearSession() {
  accessToken = null
  refreshToken = null
  localStorage.removeItem('refreshToken')
}

async function post(path, body) {
  const res = await fetch(`/auth${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || '请求失败')
    // 少数错误服务端区分不了具体原因（比如验证码"填错"和"过期"用的是同一个
    // Supabase 错误码），会额外带一个 code 字段，调用方按需读取自己处理，
    // 不需要的话 err.message 已经是能展示的文案，忽略 code 也没问题
    if (data.code) err.code = data.code
    throw err
  }
  return data
}

// App 启动时尝试用本地存的 refresh token 换一个新的 access token；
// 换不到就是真正的匿名态（没有任何残留登录态可以复用）
export async function bootstrap() {
  refreshToken = localStorage.getItem('refreshToken')
  if (!refreshToken) return null
  try {
    const data = await post('/refresh', { refreshToken })
    return applySession(data)
  } catch {
    clearSession()
    return null
  }
}

export function register(email, password, captchaToken) {
  return post('/register', { email, password, captchaToken })
}

export function resendSignup(email, captchaToken) {
  return post('/resend-signup', { email, captchaToken })
}

export async function verifySignup(email, code) {
  const data = await post('/verify-signup', { email, code })
  return applySession(data)
}

export async function login(email, password, captchaToken) {
  const data = await post('/login', { email, password, captchaToken })
  return applySession(data)
}

export function forgotPassword(email, captchaToken) {
  return post('/forgot-password', { email, captchaToken })
}

// 返回值是 resetTicket 字符串，不是 session——调用方（AuthContext）不应该把它
// 当成登录态使用，只能拿去调 resetPassword()
export async function verifyRecovery(email, code) {
  const data = await post('/verify-recovery', { email, code })
  return data.resetTicket
}

export function resetPassword(resetTicket, password) {
  return post('/reset-password', { resetTicket, password })
}

export async function logout() {
  try {
    if (refreshToken) await post('/logout', { refreshToken })
  } finally {
    clearSession()
  }
}

// 供 Hello.jsx / BalanceImport.jsx 等业务页面调用 /api/* 时使用，
// 自动带上 access token；遇到 401（大概率是 access token 过期）先用 refresh token
// 换新 token 重试一次，仍失败就把 session 清空交给 AuthContext/RequireAuth 处理跳转
export async function authorizedFetch(path, options = {}) {
  async function attempt() {
    return fetch(path, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${accessToken}`,
      },
    })
  }

  let res = await attempt()
  if (res.status === 401 && refreshToken) {
    try {
      const data = await post('/refresh', { refreshToken })
      applySession(data)
      res = await attempt()
    } catch {
      clearSession()
    }
  }
  return res
}