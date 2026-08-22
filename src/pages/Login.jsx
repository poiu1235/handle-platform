import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import AuthShell from './AuthShell'
import { useAuth } from '../lib/AuthContext'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [captchaToken, setCaptchaToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const { login } = useAuth()
  const navigate = useNavigate()

  async function handleSubmit(e) {
    e.preventDefault()
    if (!captchaToken) return setError('请先完成人机验证')
    setError('')
    setSubmitting(true)
    try {
      await login(email, password, captchaToken)
      navigate('/app', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      eyebrow="Sign In"
      title="登录账号"
      error={error}
      onCaptcha={setCaptchaToken}
      onSubmit={handleSubmit}
      submitLabel={submitting ? '处理中…' : '登录'}
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
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      <div className="toggle-row">
        还没有账号？<Link to="/register">去注册</Link>
      </div>
      <div className="toggle-row">
        <Link to="/forgot-password">忘记密码？</Link>
      </div>
    </AuthShell>
  )
}