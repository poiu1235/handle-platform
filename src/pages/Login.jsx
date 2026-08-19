import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext'

export default function Login() {
  const [mode, setMode] = useState('signin') // 'signin' | 'signup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const navigate = useNavigate()
  const { session } = useAuth()

  // 已经登录了就不用再看登录页
  if (session) {
    navigate('/', { replace: true })
    return null
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    setSubmitting(true)

    try {
      if (mode === 'signin') {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        })
        if (signInError) throw signInError
        navigate('/', { replace: true })
      } else {
        // 注册：Supabase 会发一封确认邮件，链接指回 /auth/callback，在那边落地建立 session
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback`,
          },
        })
        if (signUpError) throw signUpError
        setNotice('如果这个邮箱还没注册过，确认邮件已经发出，请去邮箱点击链接完成验证；如果这个邮箱之前已经注册并验证过，则不会收到新邮件，直接登录即可。')
        setMode('signin')
      }
    } catch (err) {
      setError(translateError(err.message))
    } finally {
      setSubmitting(false)
    }
  }

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
          <p className="ledger-eyebrow">{mode === 'signin' ? 'Sign In' : 'Sign Up'}</p>
          <h1 className="ledger-title">{mode === 'signin' ? '登录账号' : '注册新账号'}</h1>

          {notice && <div className="notice">{notice}</div>}
          {error && <div className="notice notice-error">{error}</div>}

          <form onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="email">邮箱</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="password">密码</label>
              <input
                id="password"
                type="password"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <button className="btn" type="submit" disabled={submitting}>
              {submitting ? '处理中…' : mode === 'signin' ? '登录' : '注册'}
            </button>
          </form>

          <div className="toggle-row">
            {mode === 'signin' ? (
              <>
                还没有账号？
                <button type="button" onClick={() => { setMode('signup'); setError(''); setNotice('') }}>
                  去注册
                </button>
              </>
            ) : (
              <>
                已经有账号？
                <button type="button" onClick={() => { setMode('signin'); setError(''); setNotice('') }}>
                  去登录
                </button>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

function translateError(message) {
  const map = {
    'Invalid login credentials': '邮箱或密码不正确',
    'User already registered': '该邮箱已经注册过了，直接登录即可',
    'Email not confirmed': '邮箱还未验证，请先去邮箱点击确认链接',
    'Password should be at least 6 characters': '密码至少需要 6 位',
  }
  return map[message] || message
}
