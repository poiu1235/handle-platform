import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import AuthShell from './AuthShell'
import { useAuth } from '../lib/AuthContext'
import { OTP_TTL_MS, OTP_TTL_MINUTES } from '../../shared/otpConfig'
import * as api from '../lib/apiClient'
import { useAutoDismiss } from '../lib/useAutoDismiss'

const RESEND_COOLDOWN_SECONDS = 60

export default function ForgotPassword() {
  const [step, setStep] = useState('form') // form | verify
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [captchaToken, setCaptchaToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useAutoDismiss(error, setError)
  useAutoDismiss(notice, setNotice)
  const [resendCooldown, setResendCooldown] = useState(0)
  const [codeSentAt, setCodeSentAt] = useState(null)
  const { forgotPassword, verifyRecovery } = useAuth()
  const navigate = useNavigate()
  const captchaRef = useRef(null)

  function resetCaptcha() {
    captchaRef.current?.reset()
    setCaptchaToken('')
  }

  // Supabase 对"验证码填错"和"已过期"返回的是同一个错误码，服务端区分不了
  // （见 functions/_lib/supabase.js 的注释）。这里按验证码实际发送的时间做一个
  // 尽力而为的猜测：项目配置的有效期是 10 分钟，超过了大概率是过期，没超过
  // 大概率是填错了——不是权威判断，只是给用户一个更具体一点的提示
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
    setError('')
    setSubmitting(true)
    try {
      await forgotPassword(email, captchaToken)
      setStep('verify')
      setNotice('验证码已发送到你的邮箱')
      setResendCooldown(RESEND_COOLDOWN_SECONDS)
      setCodeSentAt(Date.now())
    } catch (err) {
      setError(err.message)
    } finally {
      // Turnstile token 一次性消费——重置后验证码页会重新挂载出一个新组件，
      // "重新发送"用的是这个新 token，不是刚才发起找回密码时那个已经作废的
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
      // 验证通过后拿到的是重置票据，不是登录 session——AuthContext 会把
      // status 置为 'recovery'，跳到 /reset-password 由那边接手
      await verifyRecovery(email, code)
      navigate('/reset-password', { replace: true })
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
      await api.forgotPassword(email, captchaToken)
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
        eyebrow="Verify Code"
        title="输入验证码"
        notice={notice}
        error={error}
        onSubmit={handleVerifySubmit}
        submitLabel={submitting ? '处理中…' : '验证'}
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
      eyebrow="Forgot Password"
      title="找回密码"
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

      <div className="toggle-row">
        想起密码了？<Link to="/login">返回登录</Link>
      </div>
    </AuthShell>
  )
}