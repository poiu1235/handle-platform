import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import AuthShell from './AuthShell'
import { useAuth } from '../lib/AuthContext'
import { useAutoDismiss } from '../lib/useAutoDismiss'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [captchaToken, setCaptchaToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const { login } = useAuth()
  const navigate = useNavigate()
  const captchaRef = useRef(null)

  useAutoDismiss(error, setError)

  function resetCaptcha() {
    captchaRef.current?.reset()
    setCaptchaToken('')
  }

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
      // Turnstile 的 token 是一次性的，提交一次（不管成功还是失败）就作废了。
      // 不重置的话，下一次提交会复用同一个已经被消费过的 token，Cloudflare/Supabase
      // 会报 "timeout-or-duplicate" 拒绝——所以这里必须无条件重置，不能只在失败时做
      resetCaptcha()
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      eyebrow="Sign In"
      title="登录账号"
      error={error}
      captchaRef={captchaRef}
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