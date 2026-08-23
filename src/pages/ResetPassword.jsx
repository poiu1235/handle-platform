import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import AuthShell from './AuthShell'
import { useAuth } from '../lib/AuthContext'
import { isPasswordValid, passwordHint } from '../../shared/passwordRules'
import { useAutoDismiss } from '../lib/useAutoDismiss'

export default function ResetPassword() {
  const { status, resetPassword } = useAuth()

  // 只在这个组件第一次挂载的那一刻判断一次"我是不是正经从忘记密码流程走过来的"，
  // 之后不管全局 status 怎么变都不再重新判断——包括 resetPassword() 提交成功后
  // 把 status 从 recovery 改回 anonymous 这件事本身。
  //
  // 上一版用一个 succeeded 标记去"追上"这次 status 变化，但两者分属两次不同的
  // await 续行（各自是独立的 microtask），status 变化触发的重渲染完全可能发生在
  // succeeded 真正被置为 true 之前——那道锁上锁的时机本身就晚了，没堵住竞态，
  // 只是换了个位置继续漏。用 useState 的惰性初始化只在挂载时读一次 status，
  // 从根上让这个守卫不再对挂载之后的 status 变化敏感，就不存在"谁先谁后"的问题了。
  const [hadTicket] = useState(() => status === 'recovery')

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()

  useAutoDismiss(error, setError)

  if (!hadTicket) {
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