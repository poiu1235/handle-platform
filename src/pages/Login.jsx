import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Turnstile } from '@marsidev/react-turnstile'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { isPasswordValid, passwordHint } from '../lib/passwordRules'

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY

const COPY = {
  signin: { eyebrow: 'Sign In', title: '登录账号', button: '登录' },
  signup: { eyebrow: 'Sign Up', title: '注册新账号', button: '注册' },
  forgot: { eyebrow: 'Forgot Password', title: '找回密码', button: '发送重置邮件' },
  reset: { eyebrow: 'Reset Password', title: '设置新密码', button: '确认修改' },
}

export default function Login() {
  const [mode, setMode] = useState('signin') // 'signin' | 'signup' | 'forgot'（reset 由 isRecovery 接管，不是用户手动切换到的）
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [captchaToken, setCaptchaToken] = useState('')

  const navigate = useNavigate()
  const { session, isRecovery } = useAuth()
  const turnstileRef = useRef(null)

  // 恢复态 session 强制走"设置新密码"，跟用户手动点了哪个 tab 无关
  const currentMode = isRecovery ? 'reset' : mode

  // 已经正常登录了就不用再看登录页；但恢复态 session 不算"正常登录"，要留在这里设置新密码
  if (session && !isRecovery) {
    navigate('/', { replace: true })
    return null
  }

  function resetCaptcha() {
    turnstileRef.current?.reset()
    setCaptchaToken('')
  }

  function switchMode(nextMode) {
    setMode(nextMode)
    setEmail('')
    setPassword('')
    setConfirmPassword('')
    setError('')
    setNotice('')
    resetCaptcha()
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setNotice('')

    if (currentMode !== 'reset' && !captchaToken) {
      setError('请先完成人机验证')
      return
    }

    if ((currentMode === 'signup' || currentMode === 'reset') && password !== confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }

    if ((currentMode === 'signup' || currentMode === 'reset') && !isPasswordValid(password)) {
      setError(passwordHint())
      return
    }

    setSubmitting(true)

    try {
      if (currentMode === 'signin') {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
          options: { captchaToken },
        })
        if (signInError) throw signInError
        navigate('/', { replace: true })
      } else if (currentMode === 'signup') {
        // 注册：Supabase 会发一封确认邮件，链接指回 /auth/callback，在那边落地建立 session
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback`,
            captchaToken,
          },
        })
        if (signUpError) throw signUpError
        setNotice('如果这个邮箱还没注册过，确认邮件已经发出，请去邮箱点击链接完成验证；如果这个邮箱之前已经注册并验证过，则不会收到新邮件，直接登录即可')
        switchMode('signin')
      } else if (currentMode === 'forgot') {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
          captchaToken,
          redirectTo: `${window.location.origin}/auth/callback`,
        })
        if (resetError) throw resetError
        // 不管邮箱是否存在都用同一句提示，避免被用来枚举哪些邮箱已经注册过
        setNotice('如果该邮箱已经注册，重置密码邮件已经发出，请去邮箱点击链接完成重置')
        switchMode('signin')
      } else if (currentMode === 'reset') {
        const { error: updateError } = await supabase.auth.updateUser({ password })
        if (updateError) throw updateError
        // 设置成功后强制登出，要求用户拿新密码重新登录，而不是直接用当前恢复态 session 放行
        await supabase.auth.signOut()
        setMode('signin')
        setPassword('')
        setConfirmPassword('')
        setNotice('密码已重置，请使用新密码登录')
      }
    } catch (err) {
      setError(translateError(err.message))
    } finally {
      // Turnstile token 是一次性的，无论成功失败都要重置，否则下次提交会被拒绝
      if (currentMode !== 'reset') resetCaptcha()
      setSubmitting(false)
    }
  }

  const copy = COPY[currentMode]

  return (
    <div className="shell">
      <header className="shell-header">
        <div className="brand">
          <span className="brand-mark" />
          Handle 数据管理端
        </div>
        <span className="brand-sub">Handle Platform</span>
      </header>

      <main className="shell-main">
        <div className="ledger-card">
          <p className="ledger-eyebrow">{copy.eyebrow}</p>
          <h1 className="ledger-title">{copy.title}</h1>

          {notice && <div className="notice">{notice}</div>}
          {error && <div className="notice notice-error">{error}</div>}

          <form onSubmit={handleSubmit}>
            {currentMode === 'reset' ? (
              <div className="field">
                <label htmlFor="email">邮箱</label>
                <input id="email" type="email" value={session?.user?.email ?? ''} disabled readOnly />
              </div>
            ) : (
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
            )}

            {currentMode !== 'forgot' && (
              <div className="field">
                <label htmlFor="password">{currentMode === 'reset' ? '新密码' : '密码'}</label>
                <input
                  id="password"
                  type="password"
                  autoComplete={currentMode === 'signin' ? 'current-password' : 'new-password'}
                  required
                  minLength={currentMode === 'signin' ? undefined : 8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {(currentMode === 'signup' || currentMode === 'reset') && (
                  <p className="field-hint">{passwordHint()}</p>
                )}
              </div>
            )}

            {(currentMode === 'signup' || currentMode === 'reset') && (
              <div className="field">
                <label htmlFor="confirmPassword">确认密码</label>
                <input
                  id="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>
            )}

            {currentMode !== 'reset' && (
              <div className="field">
                <Turnstile
                  ref={turnstileRef}
                  siteKey={TURNSTILE_SITE_KEY}
                  onSuccess={(token) => setCaptchaToken(token)}
                  onExpire={() => setCaptchaToken('')}
                  onError={() => setCaptchaToken('')}
                />
              </div>
            )}

            <button
              className="btn"
              type="submit"
              disabled={submitting || (currentMode !== 'reset' && !captchaToken)}
            >
              {submitting ? '处理中…' : copy.button}
            </button>
          </form>

          {currentMode === 'signin' && (
            <>
              <div className="toggle-row">
                还没有账号？
                <button type="button" onClick={() => switchMode('signup')}>
                  去注册
                </button>
              </div>
              <div className="toggle-row">
                <button type="button" onClick={() => switchMode('forgot')}>
                  忘记密码？
                </button>
              </div>
            </>
          )}

          {currentMode === 'signup' && (
            <div className="toggle-row">
              已经有账号？
              <button type="button" onClick={() => switchMode('signin')}>
                去登录
              </button>
            </div>
          )}

          {currentMode === 'forgot' && (
            <div className="toggle-row">
              想起密码了？
              <button type="button" onClick={() => switchMode('signin')}>
                返回登录
              </button>
            </div>
          )}
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
    'captcha protection: request disallowed': '人机验证未通过，请重试',
  }
  if (map[message]) return map[message]

  // Supabase 密码强度策略的报错文案是按当前策略动态拼接生成的（会把具体要求的
  // 字符集列出来），没法用精确字符串匹配，这里用关键词兜底识别成统一的中文提示。
  if (/password/i.test(message) && /(character|characters|weak|contain|strong)/i.test(message)) {
    return passwordHint()
  }

  return message
}