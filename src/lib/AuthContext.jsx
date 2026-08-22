import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from './supabaseClient'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined) // undefined = 还没读出来，null = 确定未登录
  const [isRecovery, setIsRecovery] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
    })

    // 登录、登出、token 刷新、邮件确认/密码重置跳转落地，都会触发这里。
    // 全应用只在这里挂一个订阅，其它页面都通过 useAuth() 消费派生出来的状态，
    // 不再各自单独订阅，避免多份状态互相打架。
    const { data: listener } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (event === 'PASSWORD_RECOVERY') {
        // 用户点击了密码重置邮件里的链接，Supabase 会建立一个"恢复态" session。
        // 这个 session 只应该被用来走"设置新密码"这一步，不能当作正常登录态
        // 放行到业务页面 —— 由 isRecovery 标志统一告诉各个页面这件事。
        setIsRecovery(true)
      } else if (event === 'SIGNED_OUT') {
        // 登出（包括设置新密码成功后我们主动触发的登出）时，把恢复态标记一起清掉，
        // 避免残留状态影响下一次正常登录。
        setIsRecovery(false)
      }
      setSession(newSession)
    })

    return () => listener.subscription.unsubscribe()
  }, [])

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