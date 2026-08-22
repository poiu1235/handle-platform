import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import AuthShell from './AuthShell'
import { useAuth } from '../lib/AuthContext'
import * as api from '../lib/apiClient'

const RESEND_COOLDOWN_SECONDS = 60

export default function ForgotPassword() {
  const [step, setStep] = useState('form') // form | verify
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [captchaToken, setCaptchaToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [resendCooldown, setResendCooldown] = useState(0)
  const { forgotPassword, verifyRecovery } = useAuth()
  const navigate = useNavigate()

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
    } catch (err) {
      setError(err.message)
    } finally {
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
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleResend() {
    if (resendCooldown > 0 || submitting) return
    setSubmitting(true)
    try {
      await api.forgotPassword(email, captchaToken)
      setNotice('验证码已重新发送')
      setResendCooldown(RESEND_COOLDOWN_SECONDS)
    } catch (err) {
      setError(err.message)
    } finally {
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
        showCaptcha={false}
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
          <button type="button" onClick={handleResend} disabled={resendCooldown > 0 || submitting}>
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