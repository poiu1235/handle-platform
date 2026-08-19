import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'

export default function AuthCallback() {
  const { session, loading } = useAuth()
  const navigate = useNavigate()
  const [timedOut, setTimedOut] = useState(false)

  useEffect(() => {
    if (session) {
      navigate('/', { replace: true })
    }
  }, [session, navigate])

  useEffect(() => {
    // supabase-js 需要一点时间从 URL 里解析 code 并换取 session，给一个超时兜底
    const timer = setTimeout(() => setTimedOut(true), 6000)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="shell">
      <header className="shell-header">
        <div className="brand">
          <span className="brand-mark" />
          台账
        </div>
        <span className="brand-sub">Handle Platform</span>
      </header>

      <main className="shell-main">
        <div className="ledger-card">
          <p className="ledger-eyebrow">Verifying</p>
          <h1 className="ledger-title">正在验证邮箱…</h1>

          {!timedOut && (
            <div className="status-line">
              <span className="status-dot status-dot-pending" />
              {loading ? '正在建立登录态' : '正在跳转'}
            </div>
          )}

          {timedOut && !session && (
            <>
              <div className="notice notice-error">
                验证链接可能已过期或已被使用，请返回登录页重新发起。
              </div>
              <button className="btn" onClick={() => navigate('/login', { replace: true })}>
                返回登录页
              </button>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
