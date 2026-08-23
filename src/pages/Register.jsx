import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import AuthShell from './AuthShell'
import { useAuth } from '../lib/AuthContext'
import { isPasswordValid, passwordHint } from '../../shared/passwordRules'
import { OTP_TTL_MS, OTP_TTL_MINUTES } from '../../shared/otpConfig'
import * as api from '../lib/apiClient'

const RESEND_COOLDOWN_SECONDS = 60

export default function Register() {
  const [step, setStep] = useState('form') // form | verify
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [code, setCode] = useState('')
  const [captchaToken, setCaptchaToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [resendCooldown, setResendCooldown] = useState(0)
  const [codeSentAt, setCodeSentAt] = useState(null)
  const { register, verifySignup } = useAuth()
  const navigate = useNavigate()
  const captchaRef = useRef(null)

  // 表单页和验证码页各自只会有一个 Turnstile 挂载（两段 return 互斥），
  // 同一个 ref 可以放心复用
  function resetCaptcha() {
    captchaRef.current?.reset()
    setCaptchaToken('')
  }

  // Supabase 对"验证码填错"和"已过期"返回的是同一个错误码，服务端区分不了
  // （见 functions/_lib/supabase.js 的注释）。这里只能按验证码实际发送的时间
  // 做一个尽力而为的猜测：项目配置的有效期是 10 分钟，超过了大概率是过期，
  // 没超过大概率是填错了——不是权威判断，只是给用户一个更具体一点的提示
  function describeVerifyError(err) {
    if (err.code !== 'otp_invalid_or_expired') return err.message
    const elapsed = codeSentAt ? Date.now() - codeSentAt : Infinity
    return elapsed < OTP_TTL_MS
      ? '验证码错误，请重新输入'
      : `验证码发送已经超过${OTP_TTL_MINUTES}分钟，请重新获取`
  }

  useEffect(() => {
    if (resendCooldown <= 0) return
    const timer = setTimeout(() => setResendCooldown((s) => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [resendCooldown])

  async function handleFormSubmit(e) {
    e.preventDefault()
    if (!captchaToken) return setError('请先完成人机验证')
    if (password !== confirmPassword) return setError('两次输入的密码不一致')
    if (!isPasswordValid(password)) return setError(passwordHint())

    setError('')
    setSubmitting(true)
    try {
      await register(email, password, captchaToken)
      setStep('verify')
      setNotice('验证码已发送到你的邮箱')
      setResendCooldown(RESEND_COOLDOWN_SECONDS)
      setCodeSentAt(Date.now())
    } catch (err) {
      setError(err.message)
    } finally {
      // Turnstile token 一次性消费——不管这次注册请求成功还是失败都要重置，
      // 切到验证码页后 Turnstile 会重新挂载出一个新组件，"重新发送"要用的
      // 就是这个新 token，不是刚才发送注册请求时那个已经作废的
      resetCaptcha()
      setSubmitting(false)
    }
  }

  async function handleVerifySubmit(e) {
    e.preventDefault()
    if (code.length !== 6) return setError('请输入 6 位验证码')
    setError('')
    setSubmitting(true)
    try {
      await verifySignup(email, code)
      navigate('/app', { replace: true })
    } catch (err) {
      setError(describeVerifyError(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleResend() {
    if (resendCooldown > 0 || !captchaToken || submitting) return
    setSubmitting(true)
    try {
      await api.resendSignup(email, captchaToken)
      setNotice('验证码已重新发送')
      setResendCooldown(RESEND_COOLDOWN_SECONDS)
      setCodeSentAt(Date.now())
    } catch (err) {
      setError(err.message)
    } finally {
      resetCaptcha()
      setSubmitting(false)
    }
  }

  if (step === 'verify') {
    return (
      <AuthShell
        eyebrow="Verify Email"
        title="输入验证码"
        notice={notice}
        error={error}
        onSubmit={handleVerifySubmit}
        submitLabel={submitting ? '处理中…' : '验证并完成注册'}
        submitDisabled={submitting || code.length !== 6}
        captchaRef={captchaRef}
        onCaptcha={setCaptchaToken}
      >
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
        <div className="toggle-row">
          邮箱填错了？
          <button type="button" onClick={() => setStep('form')}>
            返回重新填写
          </button>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      eyebrow="Sign Up"
      title="注册新账号"
      error={error}
      captchaRef={captchaRef}
      onCaptcha={setCaptchaToken}
      onSubmit={handleFormSubmit}
      submitLabel={submitting ? '处理中…' : '发送验证码'}
      submitDisabled={submitting || !captchaToken}
    >
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
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="field-hint">{passwordHint()}</p>
      </div>
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

      <div className="toggle-row">
        已经有账号？<Link to="/login">去登录</Link>
      </div>
    </AuthShell>
  )
}