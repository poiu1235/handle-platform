import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import AuthShell from './AuthShell'
import { useAuth } from '../lib/AuthContext'
import { isPasswordValid, passwordHint } from '../../shared/passwordRules'

export default function ResetPassword() {
  const { status, resetPassword } = useAuth()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()

  // 只有手里攥着重置票据（status === 'recovery'）才能停在这个页面；
  // 直接改地址栏访问、票据过期后刷新页面，都会被这里挡回 /forgot-password 重新申请，
  // 而不是像旧版那样依赖一个"可能被复用"的 Supabase session 状态来判断
  if (status !== 'recovery') {
    return <Navigate to="/forgot-password" replace />
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (password !== confirmPassword) return setError('两次输入的密码不一致')
    if (!isPasswordValid(password)) return setError(passwordHint())
    setError('')
    setSubmitting(true)
    try {
      await resetPassword(password)
      navigate('/login', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      eyebrow="Reset Password"
      title="设置新密码"
      error={error}
      onSubmit={handleSubmit}
      submitLabel={submitting ? '处理中…' : '确认修改'}
      submitDisabled={submitting}
      showCaptcha={false}
    >
      <div className="field">
        <label htmlFor="password">新密码</label>
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
    </AuthShell>
  )
}