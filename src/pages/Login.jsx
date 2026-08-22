import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Turnstile } from '@marsidev/react-turnstile'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { isPasswordValid, passwordHint } from '../lib/passwordRules'

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY
const RESEND_COOLDOWN_SECONDS = 60

const COPY = {
  signin: { eyebrow: 'Sign In', title: '登录账号', button: '登录' },
  signup: { eyebrow: 'Sign Up', title: '注册新账号', button: '发送验证码' },
  'signup-verify': { eyebrow: 'Verify Email', title: '输入验证码', button: '验证并完成注册' },
  forgot: { eyebrow: 'Forgot Password', title: '找回密码', button: '发送验证码' },
  'forgot-verify': { eyebrow: 'Verify Code', title: '输入验证码', button: '验证' },
  reset: { eyebrow: 'Reset Password', title: '设置新密码', button: '确认修改' },
}

export default function Login() {
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [captchaToken, setCaptchaToken] = useState('')
  const [resendCooldown, setResendCooldown] = useState(0)

  const navigate = useNavigate()
  const { session, isRecovery } = useAuth()
  const turnstileRef = useRef(null)
  const initialModeResolved = useRef(false)

  const isRequestStep = mode === 'signin' || mode === 'signup' || mode === 'forgot'
  const isVerifyStep = mode === 'signup-verify' || mode === 'forgot-verify'

  // 页面首次加载时，根据当前 session 状态决定初始展示哪个表单：已经是正常登录就跳首页；
  // 是一个还没设置新密码的恢复态 session（比如验证码验证过了但没做完就关掉页面）就直接
  // 进"设置新密码"。只在 session 第一次从"还没读出来"变成确定值的这一刻判断一次 ——
  // 之后我们自己在提交流程里触发的 session 变化（比如 updateUser 引起的刷新）不会再
  // 重复触发这里，避免了之前"提交中途 session 短暂变化、被误判成已登录"那类竞态。
  useEffect(() => {
    if (initialModeResolved.current) return
    if (session === undefined) return
    initialModeResolved.current = true
    if (session && isRecovery) {
      setMode('reset')
    } else if (session) {
      navigate('/', { replace: true })
    }
  }, [session, isRecovery, navigate])

  // 验证码重发倒计时
  useEffect(() => {
    if (resendCooldown <= 0) return
    const timer = setTimeout(() => setResendCooldown((s) => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [resendCooldown])

  function resetCaptcha() {
    turnstileRef.current?.reset()
    setCaptchaToken('')
  }

  function switchMode(nextMode) {
    setMode(nextMode)
    setPassword('')
    setConfirmPassword('')
    setCode('')
    setError('')
    setNotice('')
    setResendCooldown(0)
    resetCaptcha()
  }

  async function sendSignupCode() {
    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { captchaToken },
    })
    if (signUpError) throw signUpError
  }

  async function sendRecoveryCode() {
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, { captchaToken })
    if (resetError) throw resetError
  }

  async function handleResend() {
    if (resendCooldown > 0 || !captchaToken || submitting) return
    setError('')
    setSubmitting(true)
    try {
      if (mode === 'signup-verify') await sendSignupCode()
      else if (mode === 'forgot-verify') await sendRecoveryCode()
      setNotice('验证码已重新发送')
      setResendCooldown(RESEND_COOLDOWN_SECONDS)
    } catch (err) {
      setError(translateError(err.message))
    } finally {
      resetCaptcha()
      setSubmitting(false)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setNotice('')

    if (isRequestStep && !captchaToken) {
      setError('请先完成人机验证')
      return
    }

    if (isVerifyStep && code.length !== 6) {
      setError('请输入 6 位验证码')
      return
    }

    if ((mode === 'signup' || mode === 'reset') && password !== confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }

    if ((mode === 'signup' || mode === 'reset') && !isPasswordValid(password)) {
      setError(passwordHint())
      return
    }

    setSubmitting(true)

    try {
      if (mode === 'signin') {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
          options: { captchaToken },
        })
        if (signInError) throw signInError
        navigate('/', { replace: true })
      } else if (mode === 'signup') {
        await sendSignupCode()
        setMode('signup-verify')
        setResendCooldown(RESEND_COOLDOWN_SECONDS)
        setNotice('验证码已发送到你的邮箱')
      } else if (mode === 'signup-verify') {
        const { error: verifyError } = await supabase.auth.verifyOtp({
          email,
          token: code,
          type: 'signup',
        })
        if (verifyError) throw verifyError
        navigate('/', { replace: true })
      } else if (mode === 'forgot') {
        await sendRecoveryCode()
        setMode('forgot-verify')
        setResendCooldown(RESEND_COOLDOWN_SECONDS)
        setNotice('验证码已发送到你的邮箱')
      } else if (mode === 'forgot-verify') {
        const { error: verifyError } = await supabase.auth.verifyOtp({
          email,
          token: code,
          type: 'recovery',
        })
        if (verifyError) throw verifyError
        // 不跳转，直接在同一个页面切到设置新密码——这一步已经拿到 session 了
        setMode('reset')
        setCode('')
        setNotice('')
      } else if (mode === 'reset') {
        const { error: updateError } = await supabase.auth.updateUser({ password })
        if (updateError) throw updateError
        // 设置成功后强制登出，要求用户拿新密码重新登录，而不是直接放行进首页
        await supabase.auth.signOut()
        setMode('signin')
        setPassword('')
        setConfirmPassword('')
        setNotice('密码已重置，请使用新密码登录')
      }
    } catch (err) {
      setError(translateError(err.message))
    } finally {
      if (!isVerifyStep) resetCaptcha()
      setSubmitting(false)
    }
  }

  const copy = COPY[mode]
  const showTurnstile = mode !== 'reset'
  const submitDisabled =
    submitting ||
    (isRequestStep && !captchaToken) ||
    (isVerifyStep && code.length !== 6)

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
            {isRequestStep && (
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

            {(isVerifyStep || mode === 'reset') && (
              <div className="field">
                <label htmlFor="email">邮箱</label>
                <input id="email" type="email" value={email} disabled readOnly />
              </div>
            )}

            {isVerifyStep && (
              <div className="field">
                <label htmlFor="code">验证码</label>
                <input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
                <p className="field-hint">验证码已发送到 {email}，6 位数字，请查收</p>
              </div>
            )}

            {(mode === 'signin' || mode === 'signup' || mode === 'reset') && (
              <div className="field">
                <label htmlFor="password">{mode === 'reset' ? '新密码' : '密码'}</label>
                <input
                  id="password"
                  type="password"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  required
                  minLength={mode === 'signin' ? undefined : 8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {(mode === 'signup' || mode === 'reset') && (
                  <p className="field-hint">{passwordHint()}</p>
                )}
              </div>
            )}

            {(mode === 'signup' || mode === 'reset') && (
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

            {showTurnstile && (
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

            <button className="btn" type="submit" disabled={submitDisabled}>
              {submitting ? '处理中…' : copy.button}
            </button>
          </form>

          {isVerifyStep && (
            <div className="toggle-row">
              没收到？
              <button
                type="button"
                onClick={handleResend}
                disabled={resendCooldown > 0 || !captchaToken || submitting}
              >
                {resendCooldown > 0 ? `重新发送(${resendCooldown}s)` : '重新发送验证码'}
              </button>
            </div>
          )}

          {mode === 'signin' && (
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

          {mode === 'signup' && (
            <div className="toggle-row">
              已经有账号？
              <button type="button" onClick={() => switchMode('signin')}>
                去登录
              </button>
            </div>
          )}

          {mode === 'signup-verify' && (
            <div className="toggle-row">
              邮箱填错了？
              <button type="button" onClick={() => switchMode('signup')}>
                返回重新填写
              </button>
            </div>
          )}

          {mode === 'forgot' && (
            <div className="toggle-row">
              想起密码了？
              <button type="button" onClick={() => switchMode('signin')}>
                返回登录
              </button>
            </div>
          )}

          {mode === 'forgot-verify' && (
            <div className="toggle-row">
              邮箱填错了？
              <button type="button" onClick={() => switchMode('forgot')}>
                返回重新填写
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
    'Email not confirmed': '邮箱还未验证，请先完成验证码验证',
    'captcha protection: request disallowed': '人机验证未通过，请重试',
    'Token has expired or is invalid': '验证码错误或已过期，请重新获取',
  }
  if (map[message]) return map[message]

  if (/password/i.test(message) && /(character|characters|weak|contain|strong)/i.test(message)) {
    return passwordHint()
  }
  if (/security purposes|only request|rate limit/i.test(message)) {
    return '请求过于频繁，请稍后再试'
  }
  if (/(token|otp|code)/i.test(message) && /(expired|invalid)/i.test(message)) {
    return '验证码错误或已过期，请重新获取'
  }

  return message
}