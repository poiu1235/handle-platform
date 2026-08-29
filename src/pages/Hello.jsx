import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import * as api from '../lib/apiClient'
import wordmark from '../assets/font_daoliti.svg'
import './board.css'

// ============================================================
// 管理端首页（台账）：分类标签 / 排序 / 0余额开关 / 卡包层叠卡片 /
// 展开滚动定位 / 左滑修改删除 / 右滑清零（深滑直提交）/ FAB 菜单 /
// 新增修改弹窗 / 删除确认弹窗。样式见 ./board.css（bd- 前缀）。
// 设计语言：design-language.md（PT Sans、品牌蓝 #5BBBEE、深蓝 hero、
// 胶囊按钮、1px #E0E0E0 描边、focus 光环、0.15–0.3s 缓动）。
// ============================================================

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

const PALETTES = {
  balance: [
    '#f4a261', '#e76f51', '#f2cc8f', '#e9c46a', '#d68c45',
    '#efb366', '#e07a5f', '#f4d35e', '#dda15e', '#eaac8b',
    '#c97b63', '#f6bd60', '#e8998d', '#d4a276', '#f28482',
    '#efc88b',
  ],
  membership: [
    '#a9dace', '#b7e5df', '#a2e4e2', '#bbe0e3', '#a8d7e2',
    '#b6dbeb', '#adcbdf', '#bbd1e9', '#a6bfe8', '#bfcae8',
    '#abb5e6', '#c3c5e6', '#b3b0e4', '#c7bfed', '#c2b5e2',
    '#d3c4ec', '#cdb0ea',
  ],
  coupon: [
    '#e6a8c7', '#eeb8cf', '#eda3bd', '#edbcc9', '#eba8b5',
    '#f2b9c0', '#eaadaf', '#f1bfbd', '#f0b0a8', '#f0cac1',
    '#efbead', '#efd3c5', '#d8e0ae', '#d8e8b9', '#c8e7a9',
    '#cae7bc',
  ],
}

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
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}年${mm}月${dd}日更新`
}

let pinyinCollator = null
try {
  pinyinCollator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { sensitivity: 'base' })
} catch (e) {
  pinyinCollator = null
}

function compareByName(a, b) {
  const nameA = (a.name || '').trim()
  const nameB = (b.name || '').trim()
  if (pinyinCollator) return pinyinCollator.compare(nameA, nameB)
  const upperA = nameA.toUpperCase()
  const upperB = nameB.toUpperCase()
  return upperA < upperB ? -1 : upperA > upperB ? 1 : 0
}

function sortItems(items, sortKey, sortDir) {
  const sorted = [...items].sort((a, b) => {
    const aZero = a.amount === 0 ? 1 : 0
    const bZero = b.amount === 0 ? 1 : 0
    if (aZero !== bZero) return aZero - bZero

    let cmp
    if (sortKey === 'amount') {
      cmp = a.amount - b.amount
    } else if (sortKey === 'name') {
      cmp = compareByName(a, b)
    } else {
      cmp = new Date(a.updatedAt) - new Date(b.updatedAt)
    }
    return sortDir === 'desc' ? -cmp : cmp
  })
  return sorted
}


// ---------- 可左右拖动的余额卡片 ----------

const ACTION_BTN_WIDTH = 66
const SWIPE_THRESHOLD = 40
const FLING_VELOCITY = 0.5
const MOMENTUM_MIN_DURATION = 120
const MOMENTUM_MAX_DURATION = 320

// 操作面板吸附展开时的宽度过渡（拖动/惯性动画进行中由 JS 逐帧接管，CSS 过渡让位）
const ACTION_PANEL_TRANSITION = 'width 0.24s cubic-bezier(0.22, 1, 0.36, 1)'

function SwipeableBalanceCard({
  item,
  expanded,
  onToggleExpand,
  onEdit,
  onDelete,
  onClear,
  stackIndex,
  stackTotal,
}) {
  const [dragX, setDragX] = useState(0)
  const [openDir, setOpenDir] = useState(null)
  const drag = useRef({
    active: false,
    startX: 0,
    baseX: 0,
    moved: false,
    rowWidth: 300,
    committing: false,
    animating: false,
  })
  const dragXRef = useRef(0)
  const velocityRef = useRef(0)
  const lastSampleRef = useRef({ x: 0, t: 0 })
  const momentumFrame = useRef(null)
  const rowRef = useRef(null)

  const isZero = item.amount === 0
  const editDeleteWidth = ACTION_BTN_WIDTH * 2
  const clearRevealWidth = isZero ? 0 : ACTION_BTN_WIDTH * 1.4

  const rowWidthGuess = drag.current.rowWidth || 300
  const commitThreshold = rowWidthGuess * 0.5
  const overCommit = !isZero && dragX >= commitThreshold

  // 卡片被右滑面板压缩到放不下金额时，把金额平滑淡出，避免它溢出画到卡片外；
  // 回滑时透明度跟着剩余宽度恢复。90px 以下完全隐藏，150px 以上完整显示
  const cardWidth = Math.max(rowWidthGuess - Math.max(dragX, 0), 0)
  const valueOpacity = Math.max(0, Math.min(1, (cardWidth - 90) / 60))

  const leftPanelWidth = Math.max(dragX, 0)
  const rightPanelWidth = Math.max(-dragX, 0)

  function animateMomentum(fromX, toX, velocity) {
    if (momentumFrame.current) cancelAnimationFrame(momentumFrame.current)
    const distance = toX - fromX
    if (distance === 0) {
      drag.current.animating = false
      return
    }
    const speed = Math.max(Math.abs(velocity), 0.05)
    const duration = Math.min(
      MOMENTUM_MAX_DURATION,
      Math.max(MOMENTUM_MIN_DURATION, Math.abs(distance) / speed)
    )
    const startTime = performance.now()
    drag.current.animating = true

    function tick(now) {
      const elapsed = now - startTime
      const t = Math.min(1, elapsed / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      const x = fromX + distance * eased
      dragXRef.current = x
      setDragX(x)
      if (t < 1) {
        momentumFrame.current = requestAnimationFrame(tick)
      } else {
        drag.current.animating = false
        momentumFrame.current = null
      }
    }
    momentumFrame.current = requestAnimationFrame(tick)
  }

  useEffect(() => {
    return () => {
      if (momentumFrame.current) cancelAnimationFrame(momentumFrame.current)
    }
  }, [])

  useEffect(() => {
    if (expanded) {
      rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } else {
      if (momentumFrame.current) {
        cancelAnimationFrame(momentumFrame.current)
        momentumFrame.current = null
      }
      drag.current.animating = false
      setOpenDir(null)
      dragXRef.current = 0
      setDragX(0)
      drag.current.moved = false
    }
  }, [expanded])

  function handlePointerDown(e) {
    if (!expanded || drag.current.committing) return
    if (momentumFrame.current) {
      cancelAnimationFrame(momentumFrame.current)
      momentumFrame.current = null
    }
    drag.current = {
      active: true,
      startX: e.clientX,
      baseX: openDir === 'left' ? -editDeleteWidth : openDir === 'right' ? clearRevealWidth : 0,
      moved: false,
      rowWidth: rowRef.current?.offsetWidth ?? 300,
      committing: false,
      animating: false,
    }
    velocityRef.current = 0
    lastSampleRef.current = { x: e.clientX, t: performance.now() }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function handlePointerMove(e) {
    if (!drag.current.active) return
    const delta = e.clientX - drag.current.startX
    if (Math.abs(delta) > 4) drag.current.moved = true
    const minX = -editDeleteWidth
    const maxX = isZero ? 0 : Math.max(clearRevealWidth, drag.current.rowWidth * 0.92)
    const next = Math.max(minX, Math.min(maxX, drag.current.baseX + delta))
    dragXRef.current = next
    setDragX(next)

    const now = performance.now()
    const dt = now - lastSampleRef.current.t
    if (dt > 0) {
      velocityRef.current = (e.clientX - lastSampleRef.current.x) / dt
    }
    lastSampleRef.current = { x: e.clientX, t: now }
  }

  function handlePointerUp() {
    if (!drag.current.active) return
    drag.current.active = false
    const threshold = (drag.current.rowWidth || 300) * 0.5
    const finalX = dragXRef.current
    const v = velocityRef.current

    const flungRight = v > FLING_VELOCITY && finalX > 0
    if (!isZero && (finalX >= threshold || flungRight)) {
      drag.current.committing = true
      setOpenDir(null)
      const flyOutX = drag.current.rowWidth + 80
      animateMomentum(finalX, flyOutX, Math.max(Math.abs(v), FLING_VELOCITY))
      window.setTimeout(() => {
        onClear(item)
        drag.current.committing = false
        dragXRef.current = 0
        setDragX(0)
      }, 220)
      return
    }

    const flungLeftOpen = v < -FLING_VELOCITY && finalX < 0
    if (finalX <= -SWIPE_THRESHOLD || flungLeftOpen) {
      setOpenDir('left')
      animateMomentum(finalX, -editDeleteWidth, v)
      return
    }

    const flungRightOpen = !isZero && v > FLING_VELOCITY && finalX >= 0
    if ((finalX >= SWIPE_THRESHOLD && !isZero) || flungRightOpen) {
      setOpenDir('right')
      animateMomentum(finalX, clearRevealWidth, v)
      return
    }

    setOpenDir(null)
    animateMomentum(finalX, 0, v)
  }

  function closeSwipe() {
    setOpenDir(null)
    dragXRef.current = 0
    setDragX(0)
  }

  function handleCardClick() {
    if (drag.current.moved) return
    if (openDir) {
      closeSwipe()
      return
    }
    onToggleExpand(item.id)
  }

  const stackZIndex = expanded ? 1000 : (stackTotal ?? 0) - (stackIndex ?? 0)

  return (
    <div
      ref={rowRef}
      className={`bd-row ${expanded ? 'bd-row-expanded' : 'bd-row-collapsed'}`}
      style={{ zIndex: stackZIndex, '--stagger': stackIndex }}
    >
      {expanded && !isZero && (
        <div
          className="bd-actions bd-actions-left"
          style={{
            width: leftPanelWidth,
            transition: drag.current.active || drag.current.animating ? 'none' : ACTION_PANEL_TRANSITION,
          }}
        >
          {overCommit ? (
            <div className="bd-action-btn bd-action-commit">清零</div>
          ) : (
            <button
              className="bd-action-btn bd-action-clear"
              onClick={() => {
                onClear(item)
                closeSwipe()
              }}
            >
              清零
            </button>
          )}
        </div>
      )}

      <div
        className={`bd-card ${isZero ? 'bd-card-zero' : ''} ${expanded ? 'bd-card-expanded' : 'bd-card-collapsed'}${
          rightPanelWidth > 0 ? ' bd-card-seam-right' : leftPanelWidth > 0 ? ' bd-card-seam-left' : ''
        }`}
        style={{
          background: isZero ? 'var(--bd-zero-card)' : colorFor('balance', item.id),
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleCardClick}
      >
        <div className="bd-card-main">
          <p className="bd-card-name">
            <span className="bd-card-mark" />
            {item.name}
          </p>
          {expanded && <p className="bd-card-meta">{formatUpdated(item.updatedAt)}</p>}
        </div>
        <div className="bd-card-value" style={{ opacity: valueOpacity }}>
          <span className="bd-card-amount">{item.amount.toLocaleString()}</span>
          <span className="bd-card-unit">{item.unit}</span>
        </div>
      </div>

      {expanded && (
        <div
          className="bd-actions bd-actions-right"
          style={{
            width: rightPanelWidth,
            transition: drag.current.active || drag.current.animating ? 'none' : ACTION_PANEL_TRANSITION,
          }}
        >
          <button
            className="bd-action-btn bd-action-edit"
            onClick={() => {
              onEdit(item)
              closeSwipe()
            }}
          >
            修改
          </button>
          <button
            className="bd-action-btn bd-action-delete"
            onClick={() => {
              onDelete(item)
              closeSwipe()
            }}
          >
            删除
          </button>
        </div>
      )}
    </div>
  )
}

// ---------- 新增 / 修改共用表单弹窗 ----------

function BalanceFormModal({ mode, initialItem, submitting, errorMessage, onClose, onSubmit }) {
  const [name, setName] = useState(mode === 'edit' ? initialItem?.name ?? '' : '')
  const [amountText, setAmountText] = useState(
    mode === 'edit' ? String(initialItem?.amount ?? '') : ''
  )

  const amountNumber = Number(amountText)
  const canSubmit = name.trim().length > 0 && amountText.trim().length > 0 && !Number.isNaN(amountNumber)

  return (
    <div className="bd-modal-backdrop" onClick={onClose}>
      <div className="bd-modal-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="bd-modal-title">{mode === 'add' ? '新增余额记录' : '修改余额记录'}</h2>

        {mode === 'add' && (
          <p className="bd-modal-hint">
            小程序名如果和已有记录重名，会直接覆盖那条记录、更新它的余额，不会新建一条重复的。
          </p>
        )}

        <div className="bd-field">
          <label>小程序名</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：肯德基"
            autoFocus
          />
        </div>
        <div className="bd-field">
          <label>余额</label>
          <input
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            placeholder="如：50"
            inputMode="decimal"
          />
        </div>

        {errorMessage && <div className="bd-notice bd-notice-error">{errorMessage}</div>}

        <div className="bd-modal-actions">
          <button className="bd-btn bd-btn-ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            className="bd-btn"
            disabled={!canSubmit || submitting}
            onClick={() => onSubmit({ name: name.trim(), amount: amountNumber })}
          >
            {submitting ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- 删除确认弹窗 ----------

function ConfirmDeleteModal({ itemName, onCancel, onConfirm }) {
  return (
    <div className="bd-modal-backdrop" onClick={onCancel}>
      <div className="bd-modal-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="bd-modal-title">删除这条记录？</h2>

        <p className="bd-modal-hint bd-modal-hint-danger">
          确定删除「{itemName}」这条记录吗？删除后会从数据库中彻底移除，之后查询不到；
          如果只是想把余额归零、以后还想保留这条记录，请用"清零"。
        </p>

        <div className="bd-modal-actions">
          <button className="bd-btn bd-btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button className="bd-btn bd-btn-danger" onClick={onConfirm}>
            确定删除
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Hello() {
  const { user, logout } = useAuth()
  const [apiState, setApiState] = useState({ status: 'pending', message: '' })

  const [activeTab, setActiveTab] = useState('balance')
  const [sortKey, setSortKey] = useState('time')
  const [sortDir, setSortDir] = useState('desc')

  const [balanceItems, setBalanceItems] = useState([])
  const [balanceState, setBalanceState] = useState({ status: 'pending', message: '' })
  const [includeZero, setIncludeZero] = useState(false)

  const [fabOpen, setFabOpen] = useState(false)
  const [expandedId, setExpandedId] = useState(null)
  const [modalState, setModalState] = useState({ open: false, mode: 'add', item: null })
  const [modalSubmitting, setModalSubmitting] = useState(false)
  const [modalError, setModalError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState(null)

  const fetchBalances = useCallback(
    async (opts = {}) => {
      if (!user) return
      const withZero = opts.includeZero ?? includeZero

      setBalanceState({ status: 'pending', message: '' })

      try {
        const res = await api.authorizedFetch(`/api/balances?includeZero=${withZero}`)
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error || `加载失败（${res.status}）`)

        setBalanceItems(
          body.map((row) => ({
            id: row.id,
            name: row.app_name,
            amount: Number(row.amount),
            unit: '元',
            updatedAt: row.updated_at,
          }))
        )
        setBalanceState({ status: 'ok', message: '' })
      } catch (err) {
        setBalanceState({ status: 'error', message: err.message })
      }
    },
    [user, includeZero]
  )

  useEffect(() => {
    fetchBalances()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  useEffect(() => {
    let cancelled = false

    async function callHelloApi() {
      try {
        const res = await api.authorizedFetch('/api/hello')
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

  function toggleExpand(id) {
    setExpandedId((cur) => (cur === id ? null : id))
  }

  function handleToggleZero() {
    const next = !includeZero
    setIncludeZero(next)
    fetchBalances({ includeZero: next })
  }

  function openAddModal() {
    setModalError('')
    setModalState({ open: true, mode: 'add', item: null })
  }

  function openEditModal(item) {
    setModalError('')
    setModalState({ open: true, mode: 'edit', item })
  }

  function closeModal() {
    setModalState({ open: false, mode: 'add', item: null })
    setModalError('')
  }

  async function handleModalSubmit({ name, amount }) {
    if (!user) return
    setModalSubmitting(true)
    setModalError('')
    const submitTime = new Date().toISOString()

    try {
      const res =
        modalState.mode === 'add'
          ? await api.authorizedFetch('/api/balances', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ app_name: name, amount, updated_at: submitTime }),
            })
          : await api.authorizedFetch(`/api/balances/${modalState.item.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ app_name: name, amount, updated_at: submitTime }),
            })

      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `保存失败（${res.status}）`)

      closeModal()
      fetchBalances()
    } catch (err) {
      setModalError(err.message)
    } finally {
      setModalSubmitting(false)
    }
  }

  function handleDeleteItem(item) {
    setDeleteTarget(item)
  }

  async function confirmDeleteItem() {
    const item = deleteTarget
    if (!item) return
    setDeleteTarget(null)

    setExpandedId((cur) => (cur === item.id ? null : cur))
    setBalanceItems((prev) => prev.filter((it) => it.id !== item.id))

    const res = await api.authorizedFetch(`/api/balances/${item.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setBalanceState({ status: 'error', message: body.error || '删除失败' })
      fetchBalances()
    }
  }

  async function handleClearItem(item) {
    const submitTime = new Date().toISOString()

    if (!includeZero) {
      setExpandedId((cur) => (cur === item.id ? null : cur))
    }
    setBalanceItems((prev) => {
      if (!includeZero) return prev.filter((it) => it.id !== item.id)
      return prev.map((it) =>
        it.id === item.id ? { ...it, amount: 0, updatedAt: submitTime } : it
      )
    })

    const res = await api.authorizedFetch(`/api/balances/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 0, updated_at: submitTime }),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setBalanceState({ status: 'error', message: body.error || '清零失败' })
      fetchBalances()
    }
  }

  return (
    <div className="bd-board">
      <header className="bd-header">
        <div className="bd-header-top">
          <div>
            <p className="bd-eyebrow">Assets Overview</p>
            <h1 className="bd-title">
              <img className="bd-title-word" src={wordmark} alt="Handle 数据管理端" />
            </h1>
          </div>
          <button className="bd-text-btn" onClick={logout}>
            退出登录
          </button>
        </div>
        <div className="bd-status">
          <span
            className={
              'bd-dot ' +
              (apiState.status === 'ok'
                ? ''
                : apiState.status === 'error'
                  ? 'bd-dot-error'
                  : 'bd-dot-pending')
            }
          />
          {apiState.status === 'pending' && `正在验证登录态…`}
          {apiState.status === 'ok' && (user?.email || apiState.message)}
          {apiState.status === 'error' && `接口调用失败：${apiState.message}`}
        </div>
      </header>

      <nav className="bd-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={`bd-tab ${activeTab === tab.key ? 'bd-tab-active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
            <span className="bd-tab-count">
              {tab.key === 'balance' ? balanceItems.length : DATA[tab.key].length}
            </span>
          </button>
        ))}
      </nav>

      <div className="bd-sort-row">
        <button
          className={`bd-sort-btn ${sortKey === 'time' ? 'bd-sort-btn-active' : ''}`}
          onClick={() => toggleSort('time')}
        >
          按更新时间 {sortKey === 'time' && (sortDir === 'desc' ? '↓' : '↑')}
        </button>
        <button
          className={`bd-sort-btn ${sortKey === 'amount' ? 'bd-sort-btn-active' : ''}`}
          onClick={() => toggleSort('amount')}
        >
          按金额 {sortKey === 'amount' && (sortDir === 'desc' ? '↓' : '↑')}
        </button>
        <button
          className={`bd-sort-btn ${sortKey === 'name' ? 'bd-sort-btn-active' : ''}`}
          onClick={() => toggleSort('name')}
        >
          按名称 {sortKey === 'name' && (sortDir === 'desc' ? '↓' : '↑')}
        </button>
      </div>

      {activeTab === 'balance' && (
        <div className="bd-zero-row">
          <label className="bd-toggle">
            <input
              type="checkbox"
              className="bd-toggle-input"
              checked={includeZero}
              onChange={handleToggleZero}
            />
            <span className="bd-toggle-track" aria-hidden="true" />
            <span className="bd-toggle-label">展示余额为0的小程序列表</span>
          </label>
        </div>
      )}

      <div className="bd-list">
        {activeTab === 'balance' && balanceState.status === 'pending' && (
          <div className="bd-status-line">
            <span className="bd-dot bd-dot-pending" />
            正在加载余额…
          </div>
        )}
        {activeTab === 'balance' && balanceState.status === 'error' && (
          <div className="bd-notice bd-notice-error">加载余额失败：{balanceState.message}</div>
        )}
        {activeTab === 'balance' &&
          balanceState.status === 'ok' &&
          balanceItems.length === 0 && (
            <div className="bd-notice">
              还没有余额数据，去
              <Link to="/app/balance-import">批量导入余额</Link>
              页面提交一批，或者用下方的"+"新增一条。
            </div>
          )}

        {sorted.map((item, idx) =>
          activeTab === 'balance' ? (
            <SwipeableBalanceCard
              key={item.id}
              item={item}
              expanded={expandedId === item.id}
              onToggleExpand={toggleExpand}
              onEdit={openEditModal}
              onDelete={handleDeleteItem}
              onClear={handleClearItem}
              stackIndex={idx}
              stackTotal={sorted.length}
            />
          ) : (
            <div
              key={item.id}
              className="bd-card bd-card-static"
              style={{ background: colorFor(activeTab, item.id), '--stagger': idx }}
            >
              <div className="bd-card-main">
                <p className="bd-card-name">
                  <span className="bd-card-mark" />
                  {item.name}
                </p>
                <p className="bd-card-meta">{formatUpdated(item.updatedAt)}</p>
              </div>
              <div className="bd-card-value">
                <span className="bd-card-amount">{item.amount.toLocaleString()}</span>
                <span className="bd-card-unit">{item.unit}</span>
              </div>
            </div>
          )
        )}
      </div>

      {activeTab === 'balance' && (
        <div className="bd-fab-wrap">
          {fabOpen && (
            <>
              <div className="bd-fab-backdrop" onClick={() => setFabOpen(false)} />
              <div className="bd-fab-menu">
                <Link className="bd-fab-menu-item" to="/app/balance-import" onClick={() => setFabOpen(false)}>
                  批量增加
                </Link>
                <button
                  className="bd-fab-menu-item"
                  onClick={() => {
                    setFabOpen(false)
                    openAddModal()
                  }}
                >
                  增加一条
                </button>
              </div>
            </>
          )}
          <button
            className={`bd-fab-btn ${fabOpen ? 'bd-fab-btn-open' : ''}`}
            onClick={() => setFabOpen((v) => !v)}
            aria-label="新增余额记录"
          >
            +
          </button>
        </div>
      )}

      {modalState.open && (
        <BalanceFormModal
          mode={modalState.mode}
          initialItem={modalState.item}
          submitting={modalSubmitting}
          errorMessage={modalError}
          onClose={closeModal}
          onSubmit={handleModalSubmit}
        />
      )}

      {deleteTarget && (
        <ConfirmDeleteModal
          itemName={deleteTarget.name}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDeleteItem}
        />
      )}
    </div>
  )
}
