import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import * as api from '../lib/apiClient'

// ---------- 数据 ----------
// 余额（balance）已接入 /api/balances（Cloudflare 中间层转发用户自己的 token 去打
// Supabase PostgREST，RLS 仍是最终的数据所有权防线），见下方 fetchBalances。
// 会籍 / 优惠券仍是 mock，接入真实数据时按同结构替换即可；
// 滑动修改/删除/清零、新增按钮目前只对余额生效（因为只有余额有真实后端）。

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

// 按 item.id 哈希取色（同一 id 永远拿到同一个颜色），异步数据也不会导致颜色跳动。
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

// 按名称排序：中文用拼音顺序，英文/数字转大写后按标准 ASCII 顺序——
// 用浏览器自带的 Intl.Collator 拼音排序（pinyin collation），不用额外引入拼音库。
let pinyinCollator = null
try {
  pinyinCollator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { sensitivity: 'base' })
} catch (e) {
  pinyinCollator = null // 极少数不支持 pinyin collation 的环境，下面会退回纯 ASCII 比较
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
    // 零余额永远沉底，不参与主排序，只在各自分组内按选定规则排
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
// 左滑（PC 向左拖）露出"修改/删除"；右滑（PC 向右拖）露出"清零"。
// 用 Pointer Events 统一处理触屏和鼠标拖动。

const ACTION_BTN_WIDTH = 66 // 每个操作按钮的固定宽度
const SWIPE_THRESHOLD = 40 // 滑动超过这个距离才算"要打开"，松手会自动吸附
const FLING_VELOCITY = 0.5 // px/ms，超过这个速度算"快速一甩"，即使没拖多远也按甩的方向处理
const MOMENTUM_MIN_DURATION = 120 // ms
const MOMENTUM_MAX_DURATION = 320 // ms

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
  const [openDir, setOpenDir] = useState(null) // 'left' | 'right' | null
  const drag = useRef({
    active: false,
    startX: 0,
    baseX: 0,
    moved: false,
    rowWidth: 300,
    committing: false,
    animating: false, // 惯性动画进行中时，CSS 的 width 过渡要让位，交给 rAF 逐帧驱动
  })
  const dragXRef = useRef(0) // 与 dragX state 同步，pointerup 读它而不是 state，避免读到过期值
  const velocityRef = useRef(0) // px/ms，正数=向右，负数=向左
  const lastSampleRef = useRef({ x: 0, t: 0 })
  const momentumFrame = useRef(null)
  const rowRef = useRef(null)

  const isZero = item.amount === 0
  const editDeleteWidth = ACTION_BTN_WIDTH * 2 // 左滑：修改+删除，固定封顶，不能再深滑
  const clearRevealWidth = isZero ? 0 : ACTION_BTN_WIDTH * 1.4 // 右滑：清零，浅滑时的基础展开宽度

  // 右滑超过卡片宽度一半 = 深滑，松手直接清零，不需要点按钮；
  // 零余额本身已经是0，右滑整个禁用。
  const rowWidthGuess = drag.current.rowWidth || 300
  const commitThreshold = rowWidthGuess * 0.5
  const overCommit = !isZero && dragX >= commitThreshold

  // 面板宽度直接从拖动距离派生：dragX>0 是右滑露出左侧"清零"面板宽度，
  // dragX<0 是左滑露出右侧"修改/删除"面板宽度；卡片本身用 flex:1 自动占满剩下的空间，
  // 不再用 transform 位移整张卡片——标题贴左、金额贴右，谁都不会被滑出可视区。
  const leftPanelWidth = Math.max(dragX, 0)
  const rightPanelWidth = Math.max(-dragX, 0)

  // 用速度驱动的缓动动画把卡片从当前位置带到目标位置，
  // 时长由速度换算：滑得越快，动画时长越短（更快收尾），
  // easeOutCubic 让它"先快后慢"，模拟惯性衰减到停止，而不是固定时长的匀速/缓动。
  function animateMomentum(fromX, toX, velocity) {
    if (momentumFrame.current) cancelAnimationFrame(momentumFrame.current)
    const distance = toX - fromX
    if (distance === 0) {
      drag.current.animating = false
      return
    }
    const speed = Math.max(Math.abs(velocity), 0.05) // px/ms，避免除0
    const duration = Math.min(
      MOMENTUM_MAX_DURATION,
      Math.max(MOMENTUM_MIN_DURATION, Math.abs(distance) / speed)
    )
    const startTime = performance.now()
    drag.current.animating = true

    function tick(now) {
      const elapsed = now - startTime
      const t = Math.min(1, elapsed / duration)
      const eased = 1 - Math.pow(1 - t, 3) // easeOutCubic
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

  // 展开时把这张卡片滚动到可视区域中间，视觉上像"从卡包里抽出来"，
  // 其余堆叠的卡片自然被滚走；收起时顺带把滑动状态复位。
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
      drag.current.moved = false // 关键修复：折叠时把"是否发生过拖动"也复位，否则被别的卡片顶替折叠后再也点不开
    }
  }, [expanded])

  function handlePointerDown(e) {
    if (!expanded || drag.current.committing) return // 折叠/退场中不响应拖动
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
    // 左滑（修改/删除）固定封顶，不能再深滑；右滑（清零）可以一路滑到接近卡片宽度触发深滑自动清零
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
    const finalX = dragXRef.current // 用 ref 而不是 state，保证拿到的是最后一帧的真实位置
    const v = velocityRef.current

    // 深滑过半，或者朝右快速一甩（哪怕没拖出多远）都直接提交清零
    const flungRight = v > FLING_VELOCITY && finalX > 0
    if (!isZero && (finalX >= threshold || flungRight)) {
      // 像聊天软件划掉会话一样，卡片整体飞出屏幕消失，
      // 动画结束后再真正提交清零（数据库那边是清零，不是删除）
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
    if (drag.current.moved) return // 刚拖动完不算点击
    if (openDir) {
      closeSwipe()
      return
    }
    onToggleExpand(item.id) // 折叠态：展开；展开态且未滑动：收起
  }

  // 折叠态层叠效果：越靠前的卡片盖住越靠后卡片的下边缘，露出后者顶边一小截；
  // 展开时跳到最上层，不被相邻卡片盖住。
  const stackZIndex = expanded ? 1000 : (stackTotal ?? 0) - (stackIndex ?? 0)

  return (
    <div
      ref={rowRef}
      className={`stamp-row ${expanded ? 'stamp-row-expanded' : 'stamp-row-collapsed'}`}
      style={{ zIndex: stackZIndex }}
    >
      {expanded && !isZero && (
        <div
          className="stamp-actions stamp-actions-left"
          style={{ width: leftPanelWidth, transition: drag.current.active || drag.current.animating ? 'none' : 'width 0.2s ease' }}
        >
          {overCommit ? (
            <div className="stamp-action-btn stamp-action-commit">清零</div>
          ) : (
            <button
              className="stamp-action-btn stamp-action-clear"
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
        className={`stamp-card ${isZero ? 'stamp-card-zero' : ''} ${expanded ? 'stamp-card-expanded' : 'stamp-card-collapsed'}`}
        style={{
          background: isZero ? 'var(--zero-card)' : colorFor('balance', item.id),
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleCardClick}
      >
        <div className="stamp-main">
          <p className="stamp-name">
            <span className="stamp-mark" />
            {item.name}
          </p>
          {expanded && <p className="stamp-meta">{formatUpdated(item.updatedAt)}</p>}
        </div>
        <div className="stamp-value">
          <span className="stamp-amount">{item.amount.toLocaleString()}</span>
          <span className="stamp-unit">{item.unit}</span>
        </div>
      </div>

      {expanded && (
        <div
          className="stamp-actions stamp-actions-right"
          style={{ width: rightPanelWidth, transition: drag.current.active || drag.current.animating ? 'none' : 'width 0.2s ease' }}
        >
          <button
            className="stamp-action-btn stamp-action-edit"
            onClick={() => {
              onEdit(item)
              closeSwipe()
            }}
          >
            修改
          </button>
          <button
            className="stamp-action-btn stamp-action-delete"
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
// mode='add'：输入框为空，展示占位提示值；mode='edit'：输入框预填列表里的真实值。

function BalanceFormModal({ mode, initialItem, submitting, errorMessage, onClose, onSubmit }) {
  const [name, setName] = useState(mode === 'edit' ? initialItem?.name ?? '' : '')
  const [amountText, setAmountText] = useState(
    mode === 'edit' ? String(initialItem?.amount ?? '') : ''
  )

  const amountNumber = Number(amountText)
  const canSubmit = name.trim().length > 0 && amountText.trim().length > 0 && !Number.isNaN(amountNumber)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{mode === 'add' ? '新增余额记录' : '修改余额记录'}</h2>

        {mode === 'add' && (
          <p className="modal-hint">
            小程序名如果和已有记录重名，会直接覆盖那条记录、更新它的余额，不会新建一条重复的。
          </p>
        )}

        <div className="field">
          <label>小程序名</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：肯德基"
            autoFocus
          />
        </div>
        <div className="field">
          <label>余额</label>
          <input
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            placeholder="如：50"
            inputMode="decimal"
          />
        </div>

        {errorMessage && <div className="notice notice-error">{errorMessage}</div>}

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            className="btn"
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

// ---------- 自定义删除确认弹窗 ----------
// 用和新增/修改共用的 modal-backdrop/modal-card 同一套底子，
// 只是把操作按钮换成危险色，视觉上和系统自带的 window.confirm 区分开。

function ConfirmDeleteModal({ itemName, onCancel, onConfirm }) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">删除这条记录？</h2>

        <p className="modal-hint modal-hint-danger">
          确定删除「{itemName}」这条记录吗？删除后会从数据库中彻底移除，之后查询不到；
          如果只是想把余额归零、以后还想保留这条记录，请用"清零"。
        </p>

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn-danger" onClick={onConfirm}>
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
  const [sortKey, setSortKey] = useState('time') // 'time' | 'amount'
  const [sortDir, setSortDir] = useState('desc') // 'desc' | 'asc'

  const [balanceItems, setBalanceItems] = useState([])
  const [balanceState, setBalanceState] = useState({ status: 'pending', message: '' })
  const [includeZero, setIncludeZero] = useState(false) // 默认不加载余额为 0 的记录

  const [fabOpen, setFabOpen] = useState(false)
  const [expandedId, setExpandedId] = useState(null) // 当前展开的余额卡片 id，同时只展开一张
  const [modalState, setModalState] = useState({ open: false, mode: 'add', item: null })
  const [modalSubmitting, setModalSubmitting] = useState(false)
  const [modalError, setModalError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState(null) // 待确认删除的 item，非空时弹出自定义确认框

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
    // 只依赖 user.id（稳定字符串），不依赖整个 user 对象引用——
    // Supabase 后台静默刷新 token 时，AuthContext 给出的 user 可能是新对象但 id 不变，
    // 依赖整个对象会导致这里被误触发，看起来像"隔一段时间就莫名其妙重新加载"。
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
    setDeleteTarget(item) // 只是打开自定义确认框，真正的删除动作放到 confirmDeleteItem 里
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
    <div className="board-shell">
      <header className="board-header">
        <div className="board-header-top">
          <div>
            <p className="ledger-eyebrow">Assets Overview</p>
            <h1 className="board-title">Handle 数据管理端</h1>
          </div>
          <div className="board-header-actions">
            <button className="text-btn" onClick={logout}>
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
        <button
          className={`board-sort-btn ${sortKey === 'name' ? 'board-sort-btn-active' : ''}`}
          onClick={() => toggleSort('name')}
        >
          按名称 {sortKey === 'name' && (sortDir === 'desc' ? '↓' : '↑')}
        </button>
      </div>

      {activeTab === 'balance' && (
        <div className="board-zero-row">
          <label className="zero-toggle">
            <input
              type="checkbox"
              className="tgl tgl-ios"
              checked={includeZero}
              onChange={handleToggleZero}
            />
            <span className="tgl-btn" />
            <span className="zero-toggle-label">展示余额为0的小程序列表</span>
          </label>
        </div>
      )}

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
          )
        )}
      </div>

      {activeTab === 'balance' && (
        <div className="fab-wrap">
          {fabOpen && (
            <>
              <div className="fab-backdrop" onClick={() => setFabOpen(false)} />
              <div className="fab-menu">
                <Link
                  className="fab-menu-item"
                  to="/app/balance-import"
                  onClick={() => setFabOpen(false)}
                >
                  批量增加
                </Link>
                <button
                  className="fab-menu-item"
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
            className={`fab-btn ${fabOpen ? 'fab-btn-open' : ''}`}
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