import { useEffect, useState } from 'react'
import { useAuth } from '../lib/AuthContext'
import { supabase } from '../lib/supabaseClient'

const DEMO_ITEMS = [
  { id: 1, label: '本月支出', amount: 8600, unit: '元', high: true },
  { id: 2, label: '待处理事项', amount: 2, unit: '项', high: false },
  { id: 3, label: '停留时长', amount: 47, unit: '分钟', high: false },
]

export default function Hello() {
  const { user, signOut } = useAuth()
  const [apiState, setApiState] = useState({ status: 'pending', message: '' })
  const [expanded, setExpanded] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function callHelloApi() {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) return

      try {
        const res = await fetch('/api/hello', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const body = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(body.error || `请求失败（${res.status}）`)
        setApiState({ status: 'ok', message: body.message })
      } catch (err) {
        if (!cancelled) setApiState({ status: 'error', message: err.message })
      }
    }

    callHelloApi()
    return () => {
      cancelled = true
    }
  }, [])

  const maxAmount = Math.max(...DEMO_ITEMS.map((i) => i.amount))

  return (
    <div className="shell">
      <header className="shell-header">
        <div className="brand">
          <span className="brand-mark" />
          台账
        </div>
        <button className="text-btn" onClick={signOut}>
          退出登录
        </button>
      </header>

      <main className="shell-main">
        <div className="ledger-card ledger-card-wide">
          <p className="ledger-eyebrow">Overview</p>
          <h1 className="hello-greeting">你好，{user?.email}</h1>
          <p className="hello-sub">已通过登录验证，以下数据来自受保护的 API 接口</p>

          <div className="status-line">
            <span
              className={
                'status-dot ' +
                (apiState.status === 'ok'
                  ? ''
                  : apiState.status === 'error'
                    ? 'status-dot-error'
                    : 'status-dot-pending')
              }
            />
            {apiState.status === 'pending' && '正在请求 /api/hello…'}
            {apiState.status === 'ok' && apiState.message}
            {apiState.status === 'error' && `接口调用失败：${apiState.message}`}
          </div>

          <div className="link-row">
            <button className="text-btn" onClick={() => setExpanded((v) => !v)}>
              {expanded ? '收起示例台账项 ▲' : '展开示例台账项 ▼'}
            </button>
          </div>

          {expanded && (
            <div style={{ marginTop: '0.6rem' }}>
              {DEMO_ITEMS.map((item) => (
                <div className="tally" key={item.id}>
                  <span className="tally-label">{item.label}</span>
                  <span className={`tally-value ${item.high ? 'tag-high' : 'tag-low'}`}>
                    {item.amount.toLocaleString()} {item.unit}
                  </span>
                </div>
              ))}
              <div className="tally-bar-track">
                <div
                  className="tally-bar-fill"
                  style={{ width: `${(DEMO_ITEMS[0].amount / maxAmount) * 100}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
