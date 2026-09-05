import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import * as api from '../lib/apiClient'
import { useCardsStore } from '../lib/cardsStore'
import {
  loadIconManifest,
  suggestIconKey,
  GENERIC_DEFAULT_ICON_RE,
  buildDefaultVisibleIcons,
} from '../lib/iconMatch'
import CardsPanel from './CardsPanel'
import wordmark from '../assets/font_daoliti.svg'
import { cardStyle } from '../lib/iconColor'
import './board.css'

// ============================================================
// 管理端首页（台账）：分类标签 / 排序 / 0余额开关 / 会员层叠卡片 /
// 展开滚动定位 / 左滑修改删除 / 右滑清零（深滑直提交）/ FAB 菜单 /
// 新增修改弹窗 / 删除确认弹窗。样式见 ./board.css（bd- 前缀）。
// 设计语言：design-language.md（PT Sans、品牌蓝 #5BBBEE、深蓝 hero、
// 胶囊按钮、1px #E0E0E0 描边、focus 光环、0.15–0.3s 缓动）。
// 会员（原「会员」，CardsPanel）取代会籍为第二个标签；面板始终挂载以承接
// 进站结算与 alert。
// ============================================================

const TABS = [
  { key: 'balance', label: '余额' },
  { key: 'cards', label: '会员' },
  { key: 'coupon', label: '优惠券' },
]

const DATA = {
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


// ---------- 卡片名称前的小标记：有 icon_key 就显示 logo，没有/加载失败则回退成菱形点 ----------
// boxSize / scale 只在展开态那张可交互卡片上用得到（见 SwipeableBalanceCard 下方的
// 说明）：图片本身永远按 40px 最大号排版，用 transform: scale(scale) 做"从小变大"，
// 外面套一层 boxSize×boxSize、overflow:hidden 的容器负责占位和裁切。静态预览卡片
// （bd-card-static，不参与展开/收起）不传这两个 prop，走原来的固定尺寸渲染。
function CardMark({ iconKey, boxSize, scale }) {
  const [failed, setFailed] = useState(false)

  // iconKey 变化时（比如切换到另一条记录复用了同一实例的极少数情况）重置失败态
  useEffect(() => {
    setFailed(false)
  }, [iconKey])

  if (iconKey && !failed) {
    const img = (
      <img
        className="bd-card-icon"
        src={`/small_icon/${encodeURIComponent(iconKey)}.png`}
        alt=""
        style={scale != null ? { transform: `scale(${scale})` } : undefined}
        onError={() => setFailed(true)}
      />
    )
    if (boxSize == null) return img
    return (
      <span className="bd-card-icon-box" style={{ width: boxSize, height: boxSize }}>
        {img}
      </span>
    )
  }
  return <span className="bd-card-mark" />
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

  // ---------- 展开态标题自适应缩放：优先缩小字号，最后才截断省略 ----------
  // titleMainRef 测的是标题所在容器（.bd-card-main）实际分到的可用宽度——
  // 这个盒子用了 flex: 1 1 0%，宽度只由 flex 分配算法决定，不受自己文字内容
  // 影响，所以可以放心用 ResizeObserver 实时测量，不会跟下面的缩放互相踩踏。
  // titleMeasureRef 是一个视觉上完全隐藏、脱离文档流的 <span>，用跟标题一样的
  // 字体在最大字号（30px）下渲染同一段文字，测出"这段标题本来需要多宽"。
  // 有了"可用宽度"和"文字在最大字号下的自然宽度"这两个数，再加上图标本身
  // 的最大/最小尺寸，就能直接解出一个 0~1 的缩放比例，让标题和图标"该缩多少
  // 缩多少"，缩到底（20px）还放不下才轮到 ellipsis 兜底截断。
  //
  // ↓↓↓ 这一段算法本身完全没变，变的是"算出来的比例怎么用"：
  // 以前是拿去改 .bd-card-name / .bd-card-icon 的 font-size / width（触发
  // WebKit 文字重排，iOS 端会有排版结果滞后于计算值的问题——具体证据见此前
  // 排查记录）；现在标题和图标永远按各自的最大号（30px / 40px）排版、
  // 不再有任何 font-size / width 过渡，"从小变大"改成对已经定型的最大号内容
  // 做 transform: scale()（纯合成层操作，不触发重排），外面套一层
  // overflow:hidden 的容器用普通数字 width/height 过渡来占位和裁切。
  const titleMainRef = useRef(null)
  const titleMeasureRef = useRef(null)
  const [titleScale, setTitleScale] = useState(1)
  const [nameNaturalWidth, setNameNaturalWidth] = useState(0)
  const [mainAvailableWidth, setMainAvailableWidth] = useState(0)

  const hasIconImage = !!item.iconKey

  // 折叠态也要用到"标题在 30px 最大字号下的自然宽度"来算外层宽度，所以这里
  // 单独测一次，不受下面那个只在展开态才跑的 ResizeObserver 门槛限制——否则
  // 一条从没被展开过的记录，折叠态会因为量不到自然宽度而把标题宽度算成 0。
  useLayoutEffect(() => {
    const measureEl = titleMeasureRef.current
    if (!measureEl) return
    setNameNaturalWidth(measureEl.offsetWidth)
	
	// 显式指定要等的字体，不依赖 document.fonts.ready 这个环境级别的"总闸"——
    // 主动把 PT Sans / LXGW WenKai 加进加载队列并等它们各自加载完成，
    // 不用猜浏览器有没有已经开始加载。
    let cancelled = false
    Promise.all([
      document.fonts.load('700 30px "PT Sans"'),
      document.fonts.load('700 30px "LXGW WenKai"'),
    ]).then(() => {
      if (cancelled) return
      const el = titleMeasureRef.current
      if (el) setNameNaturalWidth(el.offsetWidth)
    })
    return () => { cancelled = true }
  }, [item.name])

  useLayoutEffect(() => {
    if (!expanded) return
    const mainEl = titleMainRef.current
    const measureEl = titleMeasureRef.current
    if (!mainEl || !measureEl) return

    function recomputeScale() {
      const available = mainEl.clientWidth
      const naturalTextWidth = measureEl.offsetWidth
      // 图标（真图片）在 20~40px 之间跟标题同步缩放；没有图标图片、退化成菱形
      // 标记的卡片，菱形本身固定 8px 不参与缩放，公式里对应的"可变范围"就是 0
      const iconMin = hasIconImage ? 20 : 8
      const iconMax = hasIconImage ? 40 : 8
      const marginRight = hasIconImage ? 8 : 9
      const iconRange = iconMax - iconMin
      // 标题字号 fontSize(s) = 20 + 10s，文字像素宽度近似跟字号线性缩放，
      // 于是 usedWidth(s) = 图标(s) + 间距 + 文字宽度(s) 是一个关于 s 的一次式，
      // 令它等于可用宽度 available，直接解出 s，不用迭代/试错
      const c0 = iconMin + marginRight + (2 / 3) * naturalTextWidth
      const c1 = iconRange + (1 / 3) * naturalTextWidth
      const rawScale = c1 > 0 ? (available - c0) / c1 : 1
      setTitleScale(Math.max(0, Math.min(1, rawScale)))
      setNameNaturalWidth(naturalTextWidth)
      setMainAvailableWidth(available)
    }

    recomputeScale()
    const observer = new ResizeObserver(recomputeScale)
    observer.observe(mainEl)
	
	let cancelled = false
    Promise.all([
      document.fonts.load('700 30px "PT Sans"'),
      document.fonts.load('700 30px "LXGW WenKai"'),
    ]).then(() => { if (!cancelled) recomputeScale() })

    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [expanded, hasIconImage, item.name])

  // 标题 / 图标永远按最大号排版，这里把 titleScale 换算成"相对最大号的比例"
  // 和"容器该给多宽"这两组渲染真正要用的数字。折叠态没有挤压需求，直接给
  // 固定比例；展开态才用上面测出来的 titleScale。
  const nameFontTarget = expanded ? 20 + 10 * titleScale : 15
  const nameScale = nameFontTarget / 30
  const iconSizeTarget = expanded ? (hasIconImage ? 20 + 20 * titleScale : 20) : 20
  const iconScale = hasIconImage ? iconSizeTarget / 40 : 1
  const iconOuterWidth = hasIconImage ? 40 * iconScale : 8
  const iconMarginRight = hasIconImage ? 8 : 9
  // 正常情况下，外层宽度就是"自然宽度 × 比例"；只有当算法在展开态把 titleScale
  // 已经钳到 0、可用空间却还是不够时（rawScale 原本是负数），才需要再夹一次
  // 剩余可用宽度，把多出来的部分交给 .bd-card-name 自带的 ellipsis 去截断——
  // 跟这套算法改造前的兜底行为完全一致。
  const nameIdealWidth = nameNaturalWidth * nameScale
  const nameOuterWidth = expanded
    ? Math.min(nameIdealWidth, Math.max(0, mainAvailableWidth - iconOuterWidth - iconMarginRight))
    : nameIdealWidth

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
        style={
          isZero
            ? { backgroundColor: 'var(--bd-zero-card)' }
            : (() => {
                const { background, nameColor, valueColor } = cardStyle(
                  item.iconKey,
                  colorFor('balance', item.id)
                )
                return {
                  // 用 backgroundImage（长属性）而不是 background 简写：简写会把
                  // background-size / background-position 一并重置成 inline 优先级
                  // 的初始值，CSS 里给"展开态缓慢流动"用的那两个属性就会被顶掉
                  backgroundImage: background,
                  '--bd-card-name-color': nameColor,
                  '--bd-card-value-color': valueColor,
                }
              })()
        }
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleCardClick}
      >
        <div
          className="bd-card-main"
          ref={titleMainRef}
        >
          <div className="bd-card-title-row">
            <CardMark iconKey={item.iconKey} boxSize={hasIconImage ? iconOuterWidth : undefined} scale={hasIconImage ? iconScale : undefined} />
			<span className="bd-card-name-box" style={{ width: nameOuterWidth }}>
              <p
			    ref={nameVisibleRef}
                className="bd-card-name"
                style={{
                  transform: `scale(${nameScale})`,
                  // 换算回"缩放前"（30px 字号下）应该给多宽，这样缩放之后
                  // 视觉上正好等于 nameOuterWidth；放不下时这个宽度会比文字
                  // 自然宽度还小，触发 ellipsis 截断——跟改造前的兜底行为一致
                  width: nameScale > 0 ? nameOuterWidth / nameScale : 0,
                }}
              >
                {item.name}
              </p>
            </span>
          </div>
          {expanded && <p className="bd-card-meta">{formatUpdated(item.updatedAt)}</p>}
          {/* 视觉上完全隐藏、脱离文档流，只是用来量"标题在 30px 最大字号下
              本来需要多宽"——不影响布局，也不会被截断/换行 */}
          <span
            ref={titleMeasureRef}
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: -9999,
              top: 0,
              visibility: 'hidden',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              fontSize: '30px',
              fontWeight: 700,
              fontFamily: 'var(--bd-font)',
            }}
          >
            {item.name}
          </span>
		    {/* 临时诊断:每张卡片自己的名字 + 测到的自然宽度 + 有没有图标图片,排查完删掉 */}
<div
  style={{
    position: 'absolute', top: 0, right: 0, fontSize: 9, color: 'red',
    background: 'white', padding: '0 2px', zIndex: 999, whiteSpace: 'nowrap',
  }}
>
  {item.name} / nm{nameNaturalWidth.toFixed(0)} / sw{nameVisibleRef.current?.scrollWidth ?? '-'} / cw{nameVisibleRef.current?.clientWidth ?? '-'}
</div>
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

function BalanceFormModal({ mode, initialItem, items, submitting, errorMessage, onClose, onSubmit }) {
  const [name, setName] = useState(mode === 'edit' ? initialItem?.name ?? '' : '')
  const [amountText, setAmountText] = useState(
    mode === 'edit' ? String(initialItem?.amount ?? '') : ''
  )

  // 图标：null = 不配置（显示默认菱形点）。iconTouched 标记用户是否手动碰过选择器——
  // 碰过之后，输入名称不再触发自动建议覆盖用户的选择（包括用户主动选"无"）。
  const [iconKey, setIconKey] = useState(mode === 'edit' ? initialItem?.iconKey ?? null : null)
  const [iconTouched, setIconTouched] = useState(mode === 'edit' && !!initialItem?.iconKey)
  const [iconOptions, setIconOptions] = useState([])
  const [iconQuery, setIconQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    loadIconManifest().then((list) => {
      if (!cancelled) setIconOptions(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const amountNumber = Number(amountText)
  const nameTrim = name.trim()
  // 修改弹窗重名预检（2026-09-02，对齐会员编辑弹窗）：改成已有其他记录的名字
  // → 即时提示并禁止提交（新增模式不拦——重名=覆盖那条记录，是明示语义）
  const nameTaken =
    mode === 'edit' &&
    nameTrim !== (initialItem?.name ?? '') &&
    items.some((it) => it.id !== initialItem?.id && it.name === nameTrim)
  const canSubmit =
    nameTrim.length > 0 && amountText.trim().length > 0 && !Number.isNaN(amountNumber) && !nameTaken

  // 自动建议：只在用户还没手动碰过图标选择器时生效，命中就预选，没命中保持"无"。
  // 用户一旦点了任意图标选项（含"无"），iconTouched 变 true，这里永久让位。
  useEffect(() => {
    if (iconTouched) return
    setIconKey(suggestIconKey(nameTrim, iconOptions))
  }, [nameTrim, iconOptions, iconTouched])

  function pickIcon(key) {
    setIconKey(key)
    setIconTouched(true)
    setIconQuery('') // 选中后收起网格，回到"已选中"视图；重新搜索或移除会再展开
  }

  // 搜索：按标题（文件名/key）做包含匹配，不区分大小写（中文本身不受影响）。
  // "默认N"这组通用兜底图标不参与常规展示/搜索——只在搜不到任何结果时出现。
  const iconQueryTrim = iconQuery.trim().toLowerCase()
  const browsableIconOptions = useMemo(
    () => iconOptions.filter((key) => !GENERIC_DEFAULT_ICON_RE.test(key)),
    [iconOptions]
  )
  const defaultIconOptions = useMemo(
    () => iconOptions.filter((key) => GENERIC_DEFAULT_ICON_RE.test(key)),
    [iconOptions]
  )
  const matchedIconOptions = iconQueryTrim
    ? browsableIconOptions.filter((key) => key.toLowerCase().includes(iconQueryTrim))
    : buildDefaultVisibleIcons(browsableIconOptions)
  // 选择框最多两行：连"无"一起 12 个格子，一排 6 个——超出部分不展示，
  // 想找更靠后的图标用搜索框缩小范围
  const filteredIconOptions = matchedIconOptions.slice(0, 11)
  const showDefaultFallback = iconQueryTrim.length > 0 && matchedIconOptions.length === 0
  // 选中了真实图标（非"无"）且当前没在搜索时，收起网格，只显示"已选中"的锚定预览；
  // 用户重新在搜索框打字，或点预览上的"移除"，才会再展开选择网格
  const showIconPicker = iconKey === null || iconQueryTrim.length > 0

  return (
    <div className="bd-modal-backdrop" onClick={onClose}>
      <div className="bd-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="bd-modal-head">
          <h2 className="bd-modal-title">{mode === 'add' ? '新增余额记录' : '修改余额记录'}</h2>
          {mode === 'add' && (
            <p className="bd-modal-hint">
              小程序名如果和已有记录重名，会直接覆盖那条记录、更新它的余额，不会新建一条重复的。
            </p>
          )}
        </div>

        <div className="bd-modal-scroll">
          <div className="bd-field">
            <label>小程序名</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：肯德基"
              autoFocus
            />
            {nameTaken && <p className="cd-field-hint cd-field-hint-error">已有同名小程序，请换一个名字</p>}
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

          <div className="bd-field">
            <label>图标（可选）</label>

            {!showIconPicker ? (
              <div className="bd-icon-selected">
                <img
                  className="bd-icon-selected-img"
                  src={`/small_icon/${encodeURIComponent(iconKey)}.png`}
                  alt=""
                />
                <div className="bd-icon-selected-info">
                  <span className="bd-icon-selected-name">{iconKey}</span>
                  {!iconTouched && <span className="bd-icon-selected-tag">按名称自动匹配</span>}
                </div>
                <button
                  type="button"
                  className="bd-icon-selected-clear"
                  onClick={() => {
                    setIconKey(null)
                    setIconTouched(true)
                  }}
                >
                  移除
                </button>
              </div>
            ) : (
              <>
                <input
                  className="bd-icon-search"
                  value={iconQuery}
                  onChange={(e) => setIconQuery(e.target.value)}
                  placeholder="搜索图标标题，比如「喜茶」"
                />
                <div className="bd-icon-picker">
                  <button
                    type="button"
                    className={`bd-icon-option bd-icon-option-none ${iconKey === null ? 'bd-icon-option-active' : ''}`}
                    onClick={() => pickIcon(null)}
                  >
                    无
                  </button>
                  {!showDefaultFallback &&
                    filteredIconOptions.map((key) => (
                      <button
                        type="button"
                        key={key}
                        className={`bd-icon-option ${iconKey === key ? 'bd-icon-option-active' : ''}`}
                        onClick={() => pickIcon(key)}
                        title={key}
                      >
                        <img src={`/small_icon/${encodeURIComponent(key)}.png`} alt={key} />
                      </button>
                    ))}
                </div>

                {showDefaultFallback && (
                  <>
                    <p className="cd-field-hint">
                      没有找到「{iconQuery.trim()}」相关的图标，可以先从下面选一个默认图标
                    </p>
                    <div className="bd-icon-picker bd-icon-picker--scroll">
                      {defaultIconOptions.map((key) => (
                        <button
                          type="button"
                          key={key}
                          className={`bd-icon-option ${iconKey === key ? 'bd-icon-option-active' : ''}`}
                          onClick={() => pickIcon(key)}
                          title={key}
                        >
                          <img src={`/small_icon/${encodeURIComponent(key)}.png`} alt={key} />
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {errorMessage && <div className="bd-notice bd-notice-error">{errorMessage}</div>}
        </div>

        <div className="bd-modal-foot">
          <div className="bd-modal-actions">
            <button className="bd-btn bd-btn-ghost" onClick={onClose} disabled={submitting}>
              取消
            </button>
            <button
              className="bd-btn"
              disabled={!canSubmit || submitting}
              onClick={() => onSubmit({ name: name.trim(), amount: amountNumber, iconKey })}
            >
              {submitting ? '保存中…' : '保存'}
            </button>
          </div>
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
  const { rows: cardRows } = useCardsStore()
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
    async () => {
      if (!user) return

      setBalanceState({ status: 'pending', message: '' })

      try {
        // 一次全量拉取（含 0 余额）——0 余额筛选是纯前端本地过滤，开关切换零请求
        const res = await api.authorizedFetch('/api/balances')
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error || `加载失败（${res.status}）`)

        setBalanceItems(
          body.map((row) => ({
            id: row.id,
            name: row.app_name,
            amount: Number(row.amount),
            unit: '元',
            updatedAt: row.updated_at,
            iconKey: row.icon_key ?? null,
          }))
        )
        setBalanceState({ status: 'ok', message: '' })
      } catch (err) {
        setBalanceState({ status: 'error', message: err.message })
      }
    },
    [user]
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

  // 会员走 cardsStore（CardsPanel 始终挂载），DATA 无 cards 键——缺省空数组，
  // 否则 sortItems 展开 undefined 会让整个应用白屏（2026-08-31 实测修复）
  // 0 余额本地过滤（对齐会员的过期筛选模式）：全量快照在手，开关切换零请求
  const zeroCount = useMemo(
    () => balanceItems.filter((it) => it.amount === 0).length,
    [balanceItems]
  )
  const visibleBalanceItems = includeZero
    ? balanceItems
    : balanceItems.filter((it) => it.amount !== 0)
  const items = activeTab === 'balance' ? visibleBalanceItems : DATA[activeTab] ?? []
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
    // 纯客户端过滤：数据已全量在手，切换不再请求后台
    setIncludeZero((v) => !v)
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

  async function handleModalSubmit({ name, amount, iconKey }) {
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
              body: JSON.stringify({
                app_name: name,
                amount,
                updated_at: submitTime,
                icon_key: iconKey ?? null,
              }),
            })
          : await api.authorizedFetch(`/api/balances/${modalState.item.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                app_name: name,
                amount,
                updated_at: submitTime,
                icon_key: iconKey ?? null,
              }),
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

    // 清零后该行从可见列表消失（开关关闭时被本地过滤收起），收回展开态
    if (!includeZero) {
      setExpandedId((cur) => (cur === item.id ? null : cur))
    }
    // 记录保留在数据里（amount=0），可见性交给本地过滤 + 开关计数自动更新
    setBalanceItems((prev) =>
      prev.map((it) =>
        it.id === item.id ? { ...it, amount: 0, updatedAt: submitTime } : it
      )
    )

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
            <p className="bd-eyebrow">{activeTab === 'cards' ? 'Membership Overview' : 'Assets Overview'}</p>
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
              {tab.key === 'balance'
                ? balanceItems.length
                : tab.key === 'cards'
                  ? cardRows.length
                  : DATA[tab.key].length}
            </span>
          </button>
        ))}
      </nav>

      {/* 会员：面板始终挂载（进站结算与 alert 不依赖当前标签），内容仅激活时渲染 */}
      <CardsPanel active={activeTab === 'cards'} onActivate={() => setActiveTab('cards')} />

      {activeTab !== 'cards' && (
        <>
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

          {activeTab === 'balance' && zeroCount > 0 && (
            <div className="bd-zero-row">
              <label className="bd-toggle">
                <input
                  type="checkbox"
                  className="bd-toggle-input"
                  checked={includeZero}
                  onChange={handleToggleZero}
                />
                <span className="bd-toggle-track" aria-hidden="true" />
                <span className="bd-toggle-label">展示余额为0的小程序（{zeroCount}）</span>
              </label>
            </div>
          )}

          <div
            className="bd-list"
            onClick={(e) => {
              // 点空白处（卡行之外）→ 展开的卡收回折叠态（与会员页同则，2026-09-02）
              if (e.target.closest('.bd-row')) return
              setExpandedId(null)
            }}
          >
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
        </>
      )}

      {modalState.open && (
        <BalanceFormModal
          mode={modalState.mode}
          initialItem={modalState.item}
          items={balanceItems}
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