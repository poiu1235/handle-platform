import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import { supabase } from '../lib/supabaseClient'

// 对应 Supabase 邮件模板里的 {{ .Type }}，用来给不同场景显示合适的文案
const TYPE_LABEL = {
  signup: '邮箱验证',
  recovery: '密码重置',
  email_change: '邮箱变更',
  invite: '邀请',
  magiclink: '登录',
}

export default function AuthCallback() {
  const { session, isRecovery } = useAuth()
  const navigate = useNavigate()

  // 邮件模板现在直接把 token_hash / type 带到我们自己域名（而不是先经过
  // Supabase 会自动消耗 token 的官方 /verify 接口），这里只是读参数，不做任何请求
  const { tokenHash, type } = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return { tokenHash: params.get('token_hash'), type: params.get('type') }
  }, [])

  const [status, setStatus] = useState(tokenHash && type ? 'idle' : 'invalid')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    if (!session) return
    if (isRecovery) {
      // 密码重置：转去登录页，Login.jsx 会根据 isRecovery 自动切到"设置新密码"表单
      navigate('/login', { replace: true })
    } else {
      navigate('/', { replace: true })
    }
  }, [session, isRecovery, navigate])

  async function handleConfirm() {
    setStatus('verifying')
    setErrorMsg('')
    // 真正消耗 token、换取 session 的动作，被推迟到这次真实的用户点击之后才发生 ——
    // 邮箱客户端的自动预取/扫描不会模拟点击，所以不会提前把它烧掉
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
    if (error) {
      setStatus('error')
      setErrorMsg(translateVerifyError(error.message))
      return
    }
    // 成功后 onAuthStateChange 会更新 session/isRecovery，上面的 useEffect 负责后续跳转
  }

  const label = TYPE_LABEL[type] || '身份'

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
          <p className="ledger-eyebrow">Verifying</p>
          <h1 className="ledger-title">{status === 'invalid' ? '链接无效' : `完成${label}`}</h1>

          {status === 'idle' && (
            <>
              <p className="field-hint">
                出于安全考虑，需要你手动点击一下才会完成验证——这一步没法自动进行，是为了避免邮箱客户端的安全扫描在你真正点开之前就提前消耗掉这个链接。
              </p>
              <button className="btn" onClick={handleConfirm}>
                点击完成验证
              </button>
            </>
          )}

          {status === 'verifying' && (
            <div className="status-line">
              <span className="status-dot status-dot-pending" />
              正在验证…
            </div>
          )}

          {status === 'error' && (
            <>
              <div className="notice notice-error">{errorMsg}</div>
              <button className="btn" onClick={() => navigate('/login', { replace: true })}>
                返回登录页
              </button>
            </>
          )}

          {status === 'invalid' && (
            <>
              <div className="notice notice-error">
                链接缺少必要参数，可能已经失效，请返回登录页重新发起。
              </div>
              <button className="btn" onClick={() => navigate('/login', { replace: true })}>
                返回登录页
              </button>
            </>
          )}
        </div>
      </main>
    </div>
  )
}

function translateVerifyError(message) {
  const map = {
    'Token has expired or is invalid': '验证链接已过期或已被使用，请返回登录页重新发起',
    'Email link is invalid or has expired': '验证链接已过期或已被使用，请返回登录页重新发起',
  }
  if (map[message]) return map[message]
  if (/expired|invalid/i.test(message)) {
    return '验证链接已过期或已被使用，请返回登录页重新发起'
  }
  return message
}