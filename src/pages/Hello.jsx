import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/AuthContext'
import { supabase } from '../lib/supabaseClient'

// ---------- Mock 数据（接入真实数据时按同结构替换） ----------

const TABS = [
  { key: 'balance', label: '余额' },
  { key: 'membership', label: '会籍' },
  { key: 'coupon', label: '优惠券' },
]

const DATA = {
  balance: [
    { id: 'b1', name: '主账户余额', amount: 8600, unit: '元', updatedAt: '2026-08-19' },
    { id: 'b2', name: '储备备用金', amount: 1200, unit: '元', updatedAt: '2026-08-15' },
    { id: 'b3', name: '提现待入账', amount: 350, unit: '元', updatedAt: '2026-08-10' },
    { id: 'b4', name: '退款待处理', amount: 86, unit: '元', updatedAt: '2026-08-05' },
  ],
  membership: [
    { id: 'm1', name: '黄金会员', amount: 120, unit: '天', updatedAt: '2026-08-01' },
    { id: 'm2', name: '视频会员', amount: 30, unit: '天', updatedAt: '2026-08-10' },
    { id: 'm3', name: '音乐会员', amount: 7, unit: '天', updatedAt: '2026-08-18' },
  ],
  coupon: [
    { id: 'c1', name: '满100减20', amount: 20, unit: '元', updatedAt: '2026-08-12' },
    { id: 'c2', name: '新人立减券', amount: 15, unit: '元', updatedAt: '2026-08-01' },
    { id: 'c3', name: '生日专属券', amount: 50, unit: '元', updatedAt: '2026-07-20' },
    { id: 'c4', name: '会员日折扣', amount: 95, unit: '折', updatedAt: '2026-08-16' },
  ],
}

// ---------- 卡片色卡（约 50 色，全部为浅亮色，深色墨字始终可读） ----------
// 三个标签各用一组独立色系，同一标签内随机分配、不重复；
// 分配结果在组件生命周期内保持稳定（不会因排序或重渲染而跳动）。

const PALETTES = {
  // 余额 —— 暖金 / 珊瑚 / 杏橙
  balance: [
    '#e6b7a8', '#edc6b6', '#edbca3', '#eccdba', '#ebc4a7',
    '#f2d2b6', '#e9cbac', '#f0d8ba', '#f0d2a7', '#efddbe',
    '#eed8ac', '#eee1c2', '#edddb0', '#f3e8bf', '#ebe2b4',
    '#f2ecc3', '#f1ecb0',
  ],
  // 会籍 —— 冷青 / 天蓝 / 淡紫
  membership: [
    '#a9dace', '#b7e5df', '#a2e4e2', '#bbe0e3', '#a8d7e2',
    '#b6dbeb', '#adcbdf', '#bbd1e9', '#a6bfe8', '#bfcae8',
    '#abb5e6', '#c3c5e6', '#b3b0e4', '#c7bfed', '#c2b5e2',
    '#d3c4ec', '#cdb0ea',
  ],
  // 优惠券 —— 玫红 / 桃粉 + 青柠点缀
  coupon: [
    '#e6a8c7', '#eeb8cf', '#eda3bd', '#edbcc9', '#eba8b5',
    '#f2b9c0', '#eaadaf', '#f1bfbd', '#f0b0a8', '#f0cac1',
    '#efbead', '#efd3c5', '#d8e0ae', '#d8e8b9', '#c8e7a9',
    '#cae7bc',
  ],
}

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// 为每个 tab 的每一项从对应色系里不重复随机取色；调用一次即固定下来
function buildColorAssignments() {
  const map = {}
  for (const tabKey of Object.keys(DATA)) {
    const shuffled = shuffle(PALETTES[tabKey])
    DATA[tabKey].forEach((item, i) => {
      map[item.id] = shuffled[i % shuffled.length]
    })
  }
  return map
}

function formatUpdated(dateStr) {
  const d = new Date(dateStr)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}月${dd}日更新`
}

function sortItems(items, sortKey, sortDir) {
  const sorted = [...items].sort((a, b) => {
    const cmp =
      sortKey === 'amount'
        ? a.amount - b.amount
        : new Date(a.updatedAt) - new Date(b.updatedAt)
    return sortDir === 'desc' ? -cmp : cmp
  })
  return sorted
}

export default function Hello() {
  const { user, signOut } = useAuth()
  const [apiState, setApiState] = useState({ status: 'pending', message: '' })

  const [activeTab, setActiveTab] = useState('balance')
  const [sortKey, setSortKey] = useState('time') // 'time' | 'amount'
  const [sortDir, setSortDir] = useState('desc') // 'desc' | 'asc'
  const [colorMap] = useState(buildColorAssignments) // 只在挂载时随机分配一次

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

  const items = DATA[activeTab]
  const sorted = useMemo(
    () => sortItems(items, sortKey, sortDir),
    [items, sortKey, sortDir]
  )

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  return (
    <div className="board-shell">
      <header className="board-header">
        <div className="board-header-top">
          <div>
            <p className="ledger-eyebrow">Assets Overview</p>
            <h1 className="board-title">Handle 管理端</h1>
          </div>
          <button className="text-btn" onClick={signOut}>
            退出登录
          </button>
        </div>

        <div className="board-status">
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
          {apiState.status === 'pending' && `正在验证登录态…`}
          {apiState.status === 'ok' && (user?.email || apiState.message)}
          {apiState.status === 'error' && `接口调用失败：${apiState.message}`}
        </div>
      </header>

      <div className="board-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={`board-tab ${activeTab === tab.key ? 'board-tab-active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
            <span className="board-tab-count">{DATA[tab.key].length}</span>
          </button>
        ))}
      </div>

      <div className="board-sort-row">
        <button
          className={`board-sort-btn ${sortKey === 'time' ? 'board-sort-btn-active' : ''}`}
          onClick={() => toggleSort('time')}
        >
          按更新时间 {sortKey === 'time' && (sortDir === 'desc' ? '↓' : '↑')}
        </button>
        <button
          className={`board-sort-btn ${sortKey === 'amount' ? 'board-sort-btn-active' : ''}`}
          onClick={() => toggleSort('amount')}
        >
          按金额 {sortKey === 'amount' && (sortDir === 'desc' ? '↓' : '↑')}
        </button>
      </div>

      <div className="board-list">
        {sorted.map((item) => (
          <div
            key={item.id}
            className="stamp-card"
            style={{ background: colorMap[item.id] }}
          >
            <div className="stamp-main">
              <p className="stamp-name">
                <span className="stamp-mark" />
                {item.name}
              </p>
              <p className="stamp-meta">{formatUpdated(item.updatedAt)}</p>
            </div>
            <div className="stamp-value">
              <span className="stamp-amount">{item.amount.toLocaleString()}</span>
              <span className="stamp-unit">{item.unit}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}