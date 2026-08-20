import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import { supabase } from '../lib/supabaseClient'

// ---------- 数据 ----------
// 余额（balance）已接入 Supabase `balances` 表，见下方 fetchBalances。
// 会籍 / 优惠券仍是 mock，接入真实数据时按同结构替换即可。

const TABS = [
  { key: 'balance', label: '余额' },
  { key: 'membership', label: '会籍' },
  { key: 'coupon', label: '优惠券' },
]

const DATA = {
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

// 按 item.id 哈希取色（同一 id 永远拿到同一个颜色），
// 不依赖挂载时机或数据来源，异步加载的余额数据也不会导致颜色跳动。
function hashString(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0
  }
  return h
}

function colorFor(tabKey, id) {
  const palette = PALETTES[tabKey]
  return palette[hashString(String(id)) % palette.length]
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

  const [balanceItems, setBalanceItems] = useState([])
  const [balanceState, setBalanceState] = useState({ status: 'pending', message: '' })

  useEffect(() => {
    let cancelled = false

    async function fetchBalances() {
      if (!user) return

      setBalanceState({ status: 'pending', message: '' })

      const { data, error } = await supabase
        .from('balances')
        .select('id, app_name, amount, updated_at')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })

      if (cancelled) return

      if (error) {
        setBalanceState({ status: 'error', message: error.message })
        return
      }

      setBalanceItems(
        data.map((row) => ({
          id: row.id,
          name: row.app_name,
          amount: Number(row.amount),
          unit: '元',
          updatedAt: row.updated_at,
        }))
      )
      setBalanceState({ status: 'ok', message: '' })
    }

    fetchBalances()
    return () => {
      cancelled = true
    }
  }, [user])

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

  const items = activeTab === 'balance' ? balanceItems : DATA[activeTab]
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
          <div className="board-header-actions">
            <Link className="text-btn" to="/balance-import">
              批量导入余额
            </Link>
            <button className="text-btn" onClick={signOut}>
              退出登录
            </button>
          </div>
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
            <span className="board-tab-count">
              {tab.key === 'balance' ? balanceItems.length : DATA[tab.key].length}
            </span>
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
        {activeTab === 'balance' && balanceState.status === 'pending' && (
          <div className="status-line">
            <span className="status-dot status-dot-pending" />
            正在加载余额…
          </div>
        )}
        {activeTab === 'balance' && balanceState.status === 'error' && (
          <div className="notice notice-error">加载余额失败：{balanceState.message}</div>
        )}
        {activeTab === 'balance' &&
          balanceState.status === 'ok' &&
          balanceItems.length === 0 && (
            <div className="notice">
              还没有余额数据，去
              <Link to="/balance-import">批量导入余额</Link>
              页面提交一批吧。
            </div>
          )}

        {sorted.map((item) => (
          <div
            key={item.id}
            className="stamp-card"
            style={{ background: colorFor(activeTab, item.id) }}
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