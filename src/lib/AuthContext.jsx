import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from './supabaseClient'

const AuthContext = createContext(null)

// Supabase 的 access token 是一个 JWT，payload 里的 amr（Authentication Method
// Reference）记录了这个 session 是通过什么方式建立的。密码重置流程建立的 session，
// amr 数组最后一项的 method 会是 "recovery"。
//
// 这个信息编码在 token 本身里，不依赖"当前这个标签页有没有亲历过那次验证事件"，
// 所以不管是开了新标签页读到别处已经建立好的 session，还是刷新了页面导致内存里的
// state 丢失，只要能拿到 session 就能稳定推导出是不是恢复态 —— 比之前那种只在
// onAuthStateChange 抛出 PASSWORD_RECOVERY 事件那一刻才置位的做法更可靠。
function decodeJwtPayload(token) {
  try {
    const base64Url = token.split('.')[1]
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
    return JSON.parse(atob(padded))
  } catch {
    return null
  }
}

function deriveIsRecovery(session) {
  if (!session?.access_token) return false
  const payload = decodeJwtPayload(session.access_token)
  const amr = payload?.amr
  if (!Array.isArray(amr) || amr.length === 0) return false
  return amr[amr.length - 1]?.method === 'recovery'
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined) // undefined = 还没读出来，null = 确定未登录

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
    })

    // 登录、登出、token 刷新、邮件确认/密码重置跳转落地，都会触发这里。
    // 全应用只在这里挂一个订阅，其它页面都通过 useAuth() 消费派生出来的状态。
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  const isRecovery = useMemo(() => deriveIsRecovery(session), [session])

  const value = {
    session,
    user: session?.user ?? null,
    loading: session === undefined,
    isRecovery,
    signOut: () => supabase.auth.signOut(),
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内部使用')
  return ctx
}