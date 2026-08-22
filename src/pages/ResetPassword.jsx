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
  const [succeeded, setSucceeded] = useState(false)
  const navigate = useNavigate()

  // succeeded 是本地锁：resetPassword() 成功后会把全局 status 从 recovery 变成
  // anonymous，这个变化和下面 navigate('/login') 谁先触发下一次渲染是不确定的——
  // 如果 status 先变，这条守卫会在 navigate 真正生效前抢先把人送回 /forgot-password。
  // 用一个本地标记把"已经提交成功、正在离开这个页面"这件事和"status 是否还是
  // recovery"解耦，就不再依赖两个异步状态更新谁先谁后。
  if (status !== 'recovery' && !succeeded) {
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
      setSucceeded(true)
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