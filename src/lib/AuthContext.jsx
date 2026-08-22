import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import * as api from './apiClient'

const AuthContext = createContext(null)

// status 是唯一的路由判断依据，不再像旧版那样靠监听 session + 反查 amr claim 反向推断：
//   loading        —— 应用刚启动，还没确定要不要用本地 refresh token 换登录态
//   anonymous      —— 确定未登录
//   authenticated  —— 正常登录态，可以访问 /app/*
//   recovery       —— 已通过 recovery 验证码、手里攥着一张一次性重置票据，只能停在
//                      /reset-password；这张票据是纯内存态、不做持久化，5分钟有效期本来
//                      就只够走完这一次提交，刷新页面丢失是预期行为，不是 bug
export function AuthProvider({ children }) {
  const [status, setStatus] = useState('loading')
  const [user, setUser] = useState(null)
  const [resetTicket, setResetTicket] = useState(null)

  useEffect(() => {
    api.bootstrap().then((session) => {
      if (session) {
        setUser(session.user)
        setStatus('authenticated')
      } else {
        setStatus('anonymous')
      }
    })
  }, [])

  const login = useCallback(async (email, password, captchaToken) => {
    const session = await api.login(email, password, captchaToken)
    setUser(session.user)
    setStatus('authenticated')
  }, [])

  const register = useCallback((email, password, captchaToken) => api.register(email, password, captchaToken), [])

  const verifySignup = useCallback(async (email, code) => {
    const session = await api.verifySignup(email, code)
    setUser(session.user)
    setStatus('authenticated')
  }, [])

  const forgotPassword = useCallback((email, captchaToken) => api.forgotPassword(email, captchaToken), [])

  const verifyRecovery = useCallback(async (email, code) => {
    const ticket = await api.verifyRecovery(email, code)
    setResetTicket(ticket)
    setStatus('recovery')
  }, [])

  const resetPassword = useCallback(
    async (password) => {
      if (!resetTicket) throw new Error('重置会话已失效，请重新申请验证码')
      await api.resetPassword(resetTicket, password)
      setResetTicket(null)
      setStatus('anonymous')
    },
    [resetTicket]
  )

  const logout = useCallback(async () => {
    await api.logout()
    setUser(null)
    setResetTicket(null)
    setStatus('anonymous')
  }, [])

  const value = useMemo(
    () => ({ status, user, login, register, verifySignup, forgotPassword, verifyRecovery, resetPassword, logout }),
    [status, user, login, register, verifySignup, forgotPassword, verifyRecovery, resetPassword, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内部使用')
  return ctx
}