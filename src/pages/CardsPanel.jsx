import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import * as api from '../lib/apiClient'
import { loadCards, removeLocal, setEntryHandled, upsertLocal, useCardsStore } from '../lib/cardsStore'
import { useAutoDismiss } from '../lib/useAutoDismiss'
import CardsCalendar, { CardReadonlyDetail } from './CardsCalendar'
import {
  billingMaxForCycle,
  collapsedInfo,
  colorForCard,
  ddlMax,
  deriveCardView,
  dotDate,
  sortCardViews,
  shortDate,
  startDateMin,
  todayISO,
} from '../lib/cardsDomain'
import { BILLING_CYCLES } from '../../shared/cardsConfig.js'
import { cardStyle } from '../lib/iconColor'
import { suggestIconKey } from '../lib/iconMatch'
import { useIconManifest } from '../lib/useIconManifest'
import CardMark from '../components/CardMark'
import { IconPickerField, useCardIconState } from '../components/IconPicker'
import dollarIcon from '../assets/dollar.svg'
import muteIcon from '../assets/mute.svg'
import allMuteIcon from '../assets/all-mute.svg'
import notificationIcon from '../assets/notification.svg'
import './board.css'

// ============================================================
// 会员面板（PRD v2 第五章）：第四个真实标签，始终挂载——
// 进站（根组件挂载 / 跨天回焦 / 可见态 30 分钟轮询跨天，4-B37）时
// 结算 + 全量拉取一次完成，alert 覆盖任意激活标签（z 1030，5.3）。
// 清单三级交互：折叠卡 → 点击半展开（余额式宽样式：左滑拉删除、
// 右滑次操作〔浅拉清零 · 到底减一〕、「展开修改」进全量详情）→
// 全量详情（次数 / 续费区块 + 静默 / 修改）。FAB / 建卡 / 修改 /
// 删除弹窗仅在标签激活时渲染。样式见 ./board.css（cd- 前缀，复用 bd- 体系）。
// v3.2（2026-09-05）图标体系：cards.icon_key 落库（null = 按卡名自动匹配），
// 卡背景换 icon 主色渐变（cardBgStyle / iconColor.js，对齐余额），半展开卡
// 标题自适应缩放照抄 SwipeableBalanceCard 的 transform-scale 模型
// （档位低一档：字号 17~22、图标 20~28，给常驻旗标让位）。
// ============================================================

const CYCLE_LABEL = Object.fromEntries(BILLING_CYCLES.map((c) => [c.key, c.label]))

// 卡片背景：icon 主色 → 白色渐变 + 名称行对比度变量（对齐余额 cardStyle 体系）。
// iconKey 为 null（未指定且自动匹配未命中/清单未加载）时 cardStyle 回退传入的
// hash 色，渐变结构不变。沉底卡不调用（保持灰底，见各调用处的 sunkReason 分支）。
function cardBgStyle(iconKey, fallbackColor) {
  const { background, nameColor } = cardStyle(iconKey, fallbackColor)
  return {
    // 用 backgroundImage（长属性）而不是 background 简写：简写会把
    // background-size / background-position 一并重置成 inline 优先级的初始值，
    // CSS 里给"展开态缓慢流动"用的那两个属性就会被顶掉（同余额的处理）
    backgroundImage: background,
    '--bd-card-name-color': nameColor,
  }
}

// iOS 式开关：复用 0 余额开关的轨道样式（布局属性动画、布局常量照抄余额模块）
function Toggle({ checked, disabled, onChange, label }) {
  return (
    <label className="bd-toggle cd-switch">
      <input
        type="checkbox"
        className="bd-toggle-input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
      <span className="bd-toggle-track" aria-hidden="true" />
    </label>
  )
}

// 卡名旗标（2026-09-02 起改用 assets 设计稿 SVG）：
// 自动续费 = dollar.svg；静默三态 = notification.svg（提醒中）/ mute.svg（周期）/ all-mute.svg（永久）
function AutoRenewIcon() {
  return <img className="cd-flag-img" src={dollarIcon} alt="" aria-hidden="true" />
}

function MuteStateIcon({ muted }) {
  const src = muted === 'cycle' ? muteIcon : muted === 'forever' ? allMuteIcon : notificationIcon
  return <img className="cd-flag-img" src={src} alt="" aria-hidden="true" />
}

// 静默点击循环（2026-09-03 用户裁定）：自动续费卡 提醒 → 周期静默 → 永久静默 → 提醒；
// 非自动续费卡没有"下个周期"可言，只有 提醒 ⇄ 永久静默 两态
function nextMuteMode(current, autoRenew) {
  if (autoRenew) return current === 'none' ? 'cycle' : current === 'cycle' ? 'forever' : 'none'
  return current === 'none' ? 'forever' : 'none'
}

function muteNotice(mode, autoRenew) {
  if (mode === 'none') return '已恢复提醒'
  if (mode === 'cycle') return '已静默至本周期结束，顺延后自动恢复提醒'
  return autoRenew ? '已永久静默，需手动恢复' : '已静默，不再提醒'
}

// 静默循环按钮：常驻显示（提醒中 = 铃铛），点击切换到下一状态
function MuteCycleButton({ view, onCycle, className = 'cd-mute-btn cd-mute-inline' }) {
  const mode = view.muted ? view.row.muted : 'none'
  const title =
    mode === 'none'
      ? '提醒中 · 点击静默'
      : mode === 'cycle'
        ? '本周期静默 · 点击永久静默'
        : view.row.auto_renew
          ? '永久静默 · 点击恢复提醒'
          : '已静默 · 点击恢复提醒'
  return (
    <button
      type="button"
      className={className}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation()
        onCycle(view)
      }}
    >
      <MuteStateIcon muted={mode} />
    </button>
  )
}

// 名称行旗标：续费图标 + 静默循环按钮（B22：静默必须可见、可解、可再静默）。
// 修订 2026-09-03：提醒中不显示按钮——静默状态才出现图标，点击循环
// （周期 → 永久 → 解除）；静默入口在详情弹窗。
// ref 转发：半展开卡标题缩放要把旗标宽度计入"固定占用"（可用宽度扣减 + ResizeObserver）
const CardNameFlags = forwardRef(function CardNameFlags({ view, onCycleMute }, ref) {
  const { row } = view
  return (
    <span className="cd-name-flags" ref={ref}>
      {row.auto_renew && (
        <span className="cd-renew-flag" title="自动续费中">
          <AutoRenewIcon />
        </span>
      )}
      {view.muted && <MuteCycleButton view={view} onCycle={onCycleMute} />}
    </span>
  )
})

// ---------- 展开行容器（5.4：跳层 + 居中滚动，交互常量照抄余额模块） ----------

function ExpandedCardRow({ children }) {
  const rowRef = useRef(null)
  useEffect(() => {
    rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])
  return (
    <div ref={rowRef} className="bd-row bd-row-expanded" style={{ zIndex: 1000 }}>
      {children}
    </div>
  )
}

// ---------- 半展开行（余额式宽样式：左滑拉删除、右滑次操作、「展开修改」） ----------
//
// 交互映射照抄余额模块的滑动体系（Hello.jsx SwipeableBalanceCard）：
//   左滑（所有卡）→ 拉出红色「删除」→ 点击走 4-B33 动态文案确认弹窗；
//   右滑（仅次数能力开启且未用完）→ 浅拉出「减一」按钮（点击核销一次）；拉过提交
//   阈值 / 快甩 → 清零：整卡向右飞出消失（同余额右滑到底动效），提交后行以
//   "已用完"状态重新归位。阈值前整卡蒙层渐显「拉到底 清空次数」，越过半程点亮填充。
//   右滑过程中卡内容随剩余宽度渐隐（照抄余额的 90/150px 两档），不生硬滑出。
//   卡内按钮（展开修改 / 静音）不启动拖动，点击照常生效。

const CD_ACTION_BTN_WIDTH = 66
const CD_SWIPE_THRESHOLD = 40
const CD_FLING_VELOCITY = 0.5
const CD_MOMENTUM_MIN_DURATION = 120
const CD_MOMENTUM_MAX_DURATION = 320
const CD_ACTION_PANEL_TRANSITION = 'width 0.24s cubic-bezier(0.22, 1, 0.36, 1)'

// 5.8：清零提示按卡型区分——非自动续费卡行为自明、无提示
const USED_UP_NOTICE =
  '次数已清零 · 卡将沉底不再提醒；若订阅仍在续，下个周期会自动恢复次数——想让卡停止续费，请关闭自动续费（续费区块开关）'
const usedUpNotice = (row) => (row.auto_renew ? USED_UP_NOTICE : null)

function SemiExpandedCardRow({
  view,
  stackIndex,
  iconKey,
  onDelete,
  onClear,
  onDecrement,
  onFullyExpand,
  onCollapse,
  onCycleMute,
}) {
  const { row } = view
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

  // 次操作右滑仅对"次数能力开启且未用完"的卡激活（剩余 0 已沉底，无次可减）
  const canSwipeSessions = view.hasSessions && !view.usedUp
  const clearRevealWidth = canSwipeSessions ? CD_ACTION_BTN_WIDTH * 1.4 : 0
  const editDeleteWidth = CD_ACTION_BTN_WIDTH // 左滑只有「删除」一个按钮

  const rowWidthGuess = drag.current.rowWidth || 300
  const commitThreshold = rowWidthGuess * 0.5
  const overCommit = canSwipeSessions && dragX >= commitThreshold

  // 右滑压缩卡片时整个内容块平滑渐隐（照抄余额模块的 90/150px 两档透明度曲线），
  // 内容不再生硬地随卡滑出可视区
  const cardWidth = Math.max(rowWidthGuess - Math.max(dragX, 0), 0)
  const valueOpacity = Math.max(0, Math.min(1, (cardWidth - 90) / 60))

  // 减一蒙层进度：淡入段 = 清零按钮宽度起 → 提交阈值的一半；填充 = 阈值后半程
  const commitFadeStart = clearRevealWidth
  const commitFadeEnd = Math.max(commitFadeStart + 40, commitThreshold * 0.5)
  const hintOpacity = canSwipeSessions
    ? Math.max(0, Math.min(1, (dragX - commitFadeStart) / Math.max(1, commitFadeEnd - commitFadeStart)))
    : 0
  const hintFill = canSwipeSessions
    ? Math.max(0, Math.min(1, (dragX - commitThreshold * 0.5) / Math.max(1, commitThreshold * 0.5)))
    : 0

  // dragX > 0（右滑）→ 左面板（清零/减一）；dragX < 0（左滑）→ 右面板（删除）
  const leftPanelWidth = Math.max(dragX, 0)
  const rightPanelWidth = Math.max(-dragX, 0)

  // ---------- 标题自适应缩放（照抄余额 SwipeableBalanceCard 的 transform-scale 模型） ----------
  // 算法同余额：用"标题在最大字号下的自然宽度"和"标题容器实际分到的可用宽度"
  // 联立解出 0~1 的缩放比例；标题/图标永远按最大号排版（22px / 28px），
  // "从小变大"用 transform: scale()（不触发重排，WebKit 无排版滞后问题），
  // 外层 overflow:hidden 容器用普通数字 width 过渡占位裁切。
  // 档位比余额低一档（字号 17~22 vs 20~30、图标 20~28 vs 20~40）：会员卡名称行
  // 右侧还有续费/静默旗标常驻，字号让出空间（2026-09-05 裁定）。
  const semiMainRef = useRef(null)
  const semiMeasureRef = useRef(null)
  const nameFlagsRef = useRef(null)
  const hasIconImage = !!iconKey
  const [titleScale, setTitleScale] = useState(1)
  const [nameNaturalWidth, setNameNaturalWidth] = useState(0)
  const [mainAvailableWidth, setMainAvailableWidth] = useState(0)

  // 自然宽度单独测一次：不受下面"可用宽度"测量的依赖影响，保证首帧前就有值
  useLayoutEffect(() => {
    const measureEl = semiMeasureRef.current
    if (!measureEl) return
    setNameNaturalWidth(measureEl.offsetWidth)
  }, [row.name])

  useLayoutEffect(() => {
    const mainEl = semiMainRef.current
    const measureEl = semiMeasureRef.current
    const flagsEl = nameFlagsRef.current
    if (!mainEl || !measureEl) return

    function recomputeScale() {
      // 旗标是不随缩放变化的"固定占用"：从可用宽度里扣掉（含 cd-name-line 的 gap），
      // 静默按钮出现/消失不改变容器自身宽度，必须单独 observe 旗标
      const reservedWidth = (flagsEl ? flagsEl.offsetWidth : 0) + 7
      const available = mainEl.clientWidth - reservedWidth
      const naturalTextWidth = measureEl.offsetWidth
      // 没有图标图片、退化成菱形标记的卡：菱形固定 8px 不参与缩放，可变范围为 0
      const iconMin = hasIconImage ? 20 : 8
      const iconMax = hasIconImage ? 28 : 8
      const marginRight = hasIconImage ? 8 : 9
      const iconRange = iconMax - iconMin
      // 标题字号 fontSize(s) = 17 + 5s，文字像素宽度近似跟字号线性缩放，
      // usedWidth(s) = 图标(s) + 间距 + 文字宽度(s) 是关于 s 的一次式，直接解出 s
      const c0 = iconMin + marginRight + (17 / 22) * naturalTextWidth
      const c1 = iconRange + (5 / 22) * naturalTextWidth
      const rawScale = c1 > 0 ? (available - c0) / c1 : 1
      setTitleScale(Math.max(0, Math.min(1, rawScale)))
      setNameNaturalWidth(naturalTextWidth)
      setMainAvailableWidth(available)
    }

    recomputeScale()
    const observer = new ResizeObserver(recomputeScale)
    observer.observe(mainEl)
    if (flagsEl) observer.observe(flagsEl)
    return () => observer.disconnect()
  }, [hasIconImage, row.name])

  // 把 titleScale 换算成渲染要用的四个数字（公式与余额一致，档位不同）
  const nameFontTarget = 17 + 5 * titleScale
  const nameScale = nameFontTarget / 22
  const iconSizeTarget = hasIconImage ? 20 + 8 * titleScale : 20
  const iconScale = hasIconImage ? iconSizeTarget / 28 : 1
  const iconOuterWidth = hasIconImage ? 28 * iconScale : 8
  const iconMarginRight = hasIconImage ? 8 : 9
  // 正常情况外层宽度 = 自然宽度 × 比例；titleScale 钳到 0 还放不下时夹到剩余
  // 可用宽度，把多出来的部分交给 .bd-card-name 自带的 ellipsis 截断（同余额兜底）
  const nameIdealWidth = nameNaturalWidth * nameScale
  const nameOuterWidth = Math.min(
    nameIdealWidth,
    Math.max(0, mainAvailableWidth - iconOuterWidth - iconMarginRight)
  )

  function animateMomentum(fromX, toX, velocity) {
    if (momentumFrame.current) cancelAnimationFrame(momentumFrame.current)
    const distance = toX - fromX
    if (distance === 0) {
      drag.current.animating = false
      return
    }
    const speed = Math.max(Math.abs(velocity), 0.05)
    const duration = Math.min(
      CD_MOMENTUM_MAX_DURATION,
      Math.max(CD_MOMENTUM_MIN_DURATION, Math.abs(distance) / speed)
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

  function closeSwipe() {
    setOpenDir(null)
    dragXRef.current = 0
    setDragX(0)
  }

  function handlePointerDown(e) {
    if (drag.current.committing) return
    // 卡内按钮（展开修改 / 静音）放行点击，不启动拖动
    if (e.target.closest('button')) return
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
    const maxX = canSwipeSessions ? Math.max(clearRevealWidth, drag.current.rowWidth * 0.92) : 0
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

    // 右滑到底 / 快甩 → 清零：整卡向右飞出消失（照抄余额右滑到底动效），
    // 提交后行以"已用完"状态重新归位
    const flungRight = canSwipeSessions && v > CD_FLING_VELOCITY && finalX > 0
    if (canSwipeSessions && (finalX >= threshold || flungRight)) {
      drag.current.committing = true
      setOpenDir(null)
      const flyOutX = drag.current.rowWidth + 80
      animateMomentum(finalX, flyOutX, Math.max(Math.abs(v), CD_FLING_VELOCITY))
      window.setTimeout(() => {
        onClear(row)
        drag.current.committing = false
        dragXRef.current = 0
        setDragX(0)
      }, 220)
      return
    }

    const flungLeftOpen = v < -CD_FLING_VELOCITY && finalX < 0
    if (finalX <= -CD_SWIPE_THRESHOLD || flungLeftOpen) {
      setOpenDir('left')
      animateMomentum(finalX, -editDeleteWidth, v)
      return
    }

    const flungRightOpen = canSwipeSessions && v > CD_FLING_VELOCITY && finalX >= 0
    if ((finalX >= CD_SWIPE_THRESHOLD && canSwipeSessions) || flungRightOpen) {
      setOpenDir('right')
      animateMomentum(finalX, clearRevealWidth, v)
      return
    }

    setOpenDir(null)
    animateMomentum(finalX, 0, v)
  }

  function handleCardClick() {
    if (drag.current.moved) return
    if (openDir) {
      closeSwipe()
      return
    }
    onCollapse(row.id) // 再点一下收回折叠态（三级：折叠 → 半展开 → 全量详情）
  }

  const sideInfo = collapsedInfo(view)

  return (
    <div
      ref={rowRef}
      className="bd-row bd-row-expanded cd-semi-row"
      style={{ zIndex: 1000, '--stagger': stackIndex }}
    >
      {canSwipeSessions && (
        <div
          className="bd-actions bd-actions-left"
          style={{
            width: leftPanelWidth,
            transition: drag.current.active || drag.current.animating ? 'none' : CD_ACTION_PANEL_TRANSITION,
          }}
        >
          {overCommit ? (
            <div className="bd-action-btn bd-action-commit">清零</div>
          ) : (
            <button
              type="button"
              className="bd-action-btn bd-action-clear"
              onClick={() => {
                onDecrement(row)
                closeSwipe()
              }}
            >
              减一
            </button>
          )}
        </div>
      )}

      <div
        className={`bd-card bd-card-expanded cd-semi-card${view.sunkReason ? (view.sunkReason === 'expired' ? ' cd-sunk-expired' : ' cd-sunk-usedup') : ''}${
          rightPanelWidth > 0 ? ' bd-card-seam-right' : leftPanelWidth > 0 ? ' bd-card-seam-left' : ''
        }`}
        style={view.sunkReason ? undefined : cardBgStyle(iconKey, colorForCard(row.id))}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleCardClick}
      >
        <div className="cd-semi-main" ref={semiMainRef} style={{ opacity: valueOpacity }}>
          <div className="cd-name-line">
            <div className="bd-card-title-row">
              <CardMark
                iconKey={iconKey}
                boxSize={hasIconImage ? iconOuterWidth : undefined}
                scale={hasIconImage ? iconScale : undefined}
              />
              <span className="bd-card-name-box" style={{ width: nameOuterWidth }}>
                <p
                  className="bd-card-name"
                  style={{
                    transform: `scale(${nameScale})`,
                    // 换算回"缩放前"（22px 字号下）应该给多宽，缩放之后视觉上正好
                    // 等于 nameOuterWidth；放不下时触发 ellipsis 截断（同余额兜底）
                    width: nameScale > 0 ? nameOuterWidth / nameScale : 0,
                  }}
                >
                  {view.row.name}
                </p>
              </span>
            </div>
            <CardNameFlags view={view} onCycleMute={onCycleMute} ref={nameFlagsRef} />
          </div>
          <p className="cd-semi-meta">{dotDate(row.start_date)} − {dotDate(row.end_date)}</p>
          <p className="cd-semi-renew">
            {row.auto_renew ? (
              <>
                <span className="cd-tag">续费中</span>
                <span>
                  {row.period_days != null
                    ? `每 ${row.period_days} 天`
                    : CYCLE_LABEL[row.billing_cycle] || ''}
                  {row.next_billing_date ? ` · ${shortDate(row.next_billing_date)} 扣款` : ''}
                </span>
              </>
            ) : (
              <span>未开自动续费</span>
            )}
          </p>
          {/* 视觉上完全隐藏、脱离文档流：量"卡名在最大字号（22px）下本来需要多宽"，
              不影响布局（同余额 SwipeableBalanceCard 的测量节点） */}
          <span
            ref={semiMeasureRef}
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: -9999,
              top: 0,
              visibility: 'hidden',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              fontSize: '22px',
              fontWeight: 700,
              fontFamily: 'var(--bd-font)',
            }}
          >
            {view.row.name}
          </span>
        </div>

        {canSwipeSessions && hintOpacity > 0 && (
          <div className="cd-dec-hint" style={{ opacity: hintOpacity }} aria-hidden="true">
            <span className="cd-dec-hint-fill" style={{ width: `${hintFill * 100}%` }} />
            <span className="cd-dec-hint-text">拉到底 · 清空次数</span>
          </div>
        )}

        {/* 右滑（dragX > 0）时整块隐藏：槽位与「展开修改」按钮不再与提示蒙层
            重叠、也不随卡滑出可视区；左滑/静止时照常显示 */}
        {dragX <= 0 && (
          <div className="cd-semi-side">
            <div className="cd-side-slots">
              <div className="cd-side-row">
                {sideInfo.count && <span className="cd-side-count">{sideInfo.count}</span>}
                <span className="cd-side-main">{sideInfo.main}</span>
              </div>
              {sideInfo.tags.length > 0 && (
                <span className="cd-side-tags">
                  {sideInfo.tags.map((t) => (
                    <span className="cd-tag" key={t.key}>
                      {t.text}
                    </span>
                  ))}
                </span>
              )}
            </div>
            <button
              type="button"
              className="cd-expand-btn"
              onClick={(e) => {
                e.stopPropagation()
                onFullyExpand(row.id)
              }}
            >
              展开修改
            </button>
          </div>
        )}
      </div>

      <div
        className="bd-actions bd-actions-right"
        style={{
          width: rightPanelWidth,
          transition: drag.current.active || drag.current.animating ? 'none' : CD_ACTION_PANEL_TRANSITION,
        }}
      >
        <button
          type="button"
          className="bd-action-btn bd-action-delete"
          onClick={() => {
            onDelete(row)
            closeSwipe()
          }}
        >
          删除
        </button>
      </div>
    </div>
  )
}

// ---------- 折叠卡（5.4） ----------

function CardRow({ view, iconKey, stackIndex, stackTotal, onToggleExpand, onCycleMute }) {
  const { row } = view
  const info = collapsedInfo(view)
  const zIndex = (stackTotal ?? 0) - (stackIndex ?? 0)
  const sunkClass =
    view.sunkReason === 'expired' ? 'cd-sunk-expired' : view.sunkReason === 'used_up' ? 'cd-sunk-usedup' : ''

  return (
    <div className="bd-row bd-row-collapsed" style={{ zIndex, '--stagger': stackIndex }}>
      <div
        className={`bd-card bd-card-collapsed ${sunkClass}`}
        style={view.sunkReason ? undefined : cardBgStyle(iconKey, colorForCard(row.id))}
        onClick={() => onToggleExpand(row.id)}
      >
        <div className="bd-card-main">
          <div className="cd-name-line">
            {/* 折叠态无缩放：图标固定 20px（bd-card-icon 恒 40px，用 scale 缩到位），
                卡名走 15px 基础字号 + flex 收缩省略（同旧行为） */}
            <div className="bd-card-title-row">
              <CardMark
                iconKey={iconKey}
                boxSize={iconKey ? 20 : undefined}
                scale={iconKey ? 20 / 28 : undefined}
              />
              <p className="bd-card-name">{view.row.name}</p>
            </div>
            <CardNameFlags view={view} onCycleMute={onCycleMute} />
          </div>
        </div>
        {/* 双槽侧栏：左 = 剩余次数（仅次卡），右 = 剩余天数——列表按天数右对齐 */}
        <div className="cd-side-slots">
          <div className="cd-side-row">
            {info.count && <span className="cd-side-count">{info.count}</span>}
            <span className="cd-side-main">{info.main}</span>
          </div>
          {info.tags.length > 0 && (
            <span className="cd-side-tags">
              {info.tags.map((t) => (
                <span className="cd-tag" key={t.key}>
                  {t.text}
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- 全量详情（半展开「展开修改」后的全字段修改态：双能力区块 + 静默 / 修改；
// 删除走半展开左滑，顺延走「修改」弹窗终止日期——操作区不再各设按钮） ----------

function CardDetail({ view, iconKey, today, onPatch, onNotice, onEdit, onCollapse }) {
  const row = view.row
  const maxDdl = ddlMax(today)

  const [silenceOpen, setSilenceOpen] = useState(false)
  const [remainingDraft, setRemainingDraft] = useState(
    row.remaining_sessions == null ? '' : String(row.remaining_sessions)
  )
  const [enabling, setEnabling] = useState(false)
  const [enableRemaining, setEnableRemaining] = useState('')
  // 续费周期下拉草稿：日历周期 key（week/month/quarter/year）或 'fixed'（固定天数）
  const [cycleDraft, setCycleDraft] = useState(row.period_days != null ? 'fixed' : row.billing_cycle || 'month')
  const [periodDaysDraft, setPeriodDaysDraft] = useState(row.period_days == null ? '' : String(row.period_days))
  const [billingDateDraft, setBillingDateDraft] = useState(row.next_billing_date || '')
  // 周期刷新次数（2026-09-02 裁定从次数区块移入续费区块）：'unlimited' = 无限
  // （不自动重置，等扫描校准 3.4.3）| 'fixed' = 每周期重置为 refreshCountDraft
  const [refreshModeDraft, setRefreshModeDraft] = useState(
    row.total_sessions != null ? 'fixed' : 'unlimited'
  )
  const [refreshCountDraft, setRefreshCountDraft] = useState(
    row.total_sessions == null ? '' : String(row.total_sessions)
  )
  // 开启自动续费走「保存/取消」草稿流（与次数能力开启一致）：只有保存成功开关才置开
  const [renewEnabling, setRenewEnabling] = useState(false)

  // 静默菜单：点到其他地方自动缩回（关闭）
  const silenceWrapRef = useRef(null)
  useEffect(() => {
    if (!silenceOpen) return
    function onDocPointerDown(e) {
      if (silenceWrapRef.current && !silenceWrapRef.current.contains(e.target)) {
        setSilenceOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    return () => document.removeEventListener('pointerdown', onDocPointerDown)
  }, [silenceOpen])

  // 行随每次 PATCH 响应更新——草稿始终向服务端真值对齐。
  // 用"渲染期根据前一行调整状态"的官方模式（等价于按 row 派生草稿），避免 effect 级联渲染
  const [prevRow, setPrevRow] = useState(row)
  if (prevRow !== row) {
    setPrevRow(row)
    setRemainingDraft(row.remaining_sessions == null ? '' : String(row.remaining_sessions))
    if (!renewEnabling) {
      // 开启草稿态跳过：用户正按"先周期后日期"填写，PATCH 响应不得冲掉草稿
      setCycleDraft(row.period_days != null ? 'fixed' : row.billing_cycle || 'month')
      setPeriodDaysDraft(row.period_days == null ? '' : String(row.period_days))
      setBillingDateDraft(row.next_billing_date || '')
      setRefreshModeDraft(row.total_sessions != null ? 'fixed' : 'unlimited')
      setRefreshCountDraft(row.total_sessions == null ? '' : String(row.total_sessions))
    }
  }

  function syncSessionDrafts() {
    setRemainingDraft(row.remaining_sessions == null ? '' : String(row.remaining_sessions))
  }

  // ── 次数草稿（激活态改值 → 出「保存/取消」，不再 blur 直提）──
  // 每周期次数已移入续费区块（周期刷新次数，2026-09-02）——此处只管剩余次数
  function saveSessionDrafts() {
    const rText = remainingDraft.trim()
    if (!/^\d+$/.test(rText)) {
      onNotice('剩余次数需为不小于 0 的整数', 'error')
      return
    }
    const patch = {}
    if (Number(rText) !== row.remaining_sessions) patch.remaining_sessions = Number(rText)
    if (Object.keys(patch).length === 0) return
    onPatch(patch, { successNotice: '已保存' })
  }

  function submitEnable() {
    const rText = enableRemaining.trim()
    if (!/^\d+$/.test(rText) || Number(rText) <= 0) {
      onNotice('开启次数能力时剩余次数必填且需大于 0', 'error')
      return
    }
    onPatch({ remaining_sessions: Number(rText) }, { after: () => setEnabling(false) })
  }

  function handleSessionsToggle(next) {
    if (!next) {
      onPatch({ remaining_sessions: null, total_sessions: null }) // 双向可逆，无确认（4-B31）
    } else {
      setEnableRemaining('')
      setEnabling(true)
    }
  }

  // ── 续费区块（开关是续费唯一入口；开启走「保存/取消」草稿流——拨开只进入
  // 修改态，保存成功后开关才真正置开；关闭保持一键直提）──
  function handleRenewToggle(next) {
    if (!next) {
      setRenewEnabling(false)
      // 周期刷新次数随续费一并失效（2026-09-02 裁定）：关掉自动续费 → total_sessions
      // 置 null（次数能力本身保留，剩余次数不动；下次重开续费需重新配置刷新次数）
      onPatch(
        row.total_sessions != null ? { auto_renew: false, total_sessions: null } : { auto_renew: false },
        { successNotice: '关闭后将不再自动顺延，卡会在 DDL 后自然过期' }
      )
      return
    }
    // 进入开启草稿态：周期清空——必须先选周期（选固定天数还要先填天数），
    // 下一次扣款日输入框才出现（先周期后日期，避免"先选日期再选周期"）；
    // 周期刷新次数从库内现值出发（卡可能早已配置 total_sessions）；
    // 用户裁定 2026-09-03：次数能力开着且从未配过每周期次数 → 默认固定次数 =
    // 剩余次数（开续费的直觉就是"每周期恢复到买的时候"），否则无限
    setCycleDraft('')
    setPeriodDaysDraft('')
    setBillingDateDraft('')
    if (view.hasSessions && row.total_sessions == null) {
      setRefreshModeDraft('fixed')
      setRefreshCountDraft(String(row.remaining_sessions ?? ''))
    } else {
      setRefreshModeDraft(row.total_sessions != null ? 'fixed' : 'unlimited')
      setRefreshCountDraft(row.total_sessions == null ? '' : String(row.total_sessions))
    }
    setRenewEnabling(true)
  }

  // 续费草稿统一取消：开启草稿与已开启卡的修改共用——回退到服务端真值
  function cancelRenewEdit() {
    setRenewEnabling(false)
    setCycleDraft(row.period_days != null ? 'fixed' : row.billing_cycle || 'month')
    setPeriodDaysDraft(row.period_days == null ? '' : String(row.period_days))
    setBillingDateDraft(row.next_billing_date || '')
    setRefreshModeDraft(row.total_sessions != null ? 'fixed' : 'unlimited')
    setRefreshCountDraft(row.total_sessions == null ? '' : String(row.total_sessions))
  }

  // 续费草稿统一提交：开启草稿（renewEnabling）与已开启卡的修改共用。
  // DDL ≡ 扣款日（用户裁定 2026-09-02）：开启或改扣款日时同步写 end_date，
  // 使两者恒同值——快到期窗口随之覆盖原有效期；关闭续费不动 end_date（有效期
  // 停在最后的扣款日）。周期限窗（需求 2）：扣款日 ∈ [今天, 本周期上限]
  function saveRenewEdit() {
    if (!cycleDraft) {
      onNotice('请先选择扣款周期', 'error')
      return
    }
    const date = billingDateDraft
    if (!date) {
      onNotice('请选择扣款日', 'error')
      return
    }
    const cyc = cycleDraft === 'fixed' ? 'fixed' : cycleDraft
    const upper = billingMaxForCycle(today, cyc, Number(periodDaysDraft.trim()) || undefined)
    if (date < today || (upper && date > upper)) {
      onNotice(upper ? `扣款日需在今天至 ${upper} 之间（本周期内）` : `扣款日需不早于今天`, 'error')
      return
    }
    const patch = {}
    if (renewEnabling) patch.auto_renew = true
    if (cycleDraft === 'fixed') {
      const t = periodDaysDraft.trim()
      if (!/^\d+$/.test(t) || Number(t) <= 0) {
        onNotice('固定天数需为正整数', 'error')
        return
      }
      if (renewEnabling || row.period_days !== Number(t)) patch.period_days = Number(t)
    } else if (renewEnabling || row.period_days != null || row.billing_cycle !== cycleDraft) {
      patch.billing_cycle = cycleDraft
    }
    if (renewEnabling || date !== (row.next_billing_date || '')) {
      patch.next_billing_date = date
      // DDL 同步：开启或改扣款日 → end_date 跟随（已开启修改仅在日期变化时携带）
      if (renewEnabling || row.end_date !== date) patch.end_date = date
    }
    // 周期刷新次数（次数能力开启时才可配置；cards_count_pair：能力未开启时
    // total 必须为 null，不携带即不动）——'unlimited' → 置 null（不自动重置，
    // 等扫描校准 3.4.3），'fixed' → 正整数
    if (view.hasSessions) {
      if (refreshModeDraft === 'fixed') {
        const cText = refreshCountDraft.trim()
        if (!/^\d+$/.test(cText) || Number(cText) <= 0) {
          onNotice('每周期刷新次数需为大于 0 的整数（或选「无限」）', 'error')
          return
        }
        if (Number(cText) !== row.total_sessions) patch.total_sessions = Number(cText)
      } else if (row.total_sessions != null) {
        patch.total_sessions = null
      }
    }
    if (Object.keys(patch).length === 0) {
      setRenewEnabling(false)
      return
    }
    onPatch(patch, {
      successNotice: renewEnabling ? '已开启自动续费' : '已保存',
      after: () => setRenewEnabling(false),
    })
  }

  // 已开启卡的行内草稿：改动 → 出「保存/取消」；保存 = 提交草稿 diff，取消 = 回退真值
  function sessionsDirty() {
    const rText = remainingDraft.trim()
    return rText !== (row.remaining_sessions == null ? '' : String(row.remaining_sessions))
  }

  function renewDraftDirty() {
    if (!row.auto_renew) return false
    const cChanged =
      cycleDraft !== (row.period_days != null ? 'fixed' : row.billing_cycle || 'month')
    const dChanged = periodDaysDraft.trim() !== (row.period_days == null ? '' : String(row.period_days))
    const bChanged = billingDateDraft !== (row.next_billing_date || '')
    // 周期刷新次数（次数能力开启时才参与 dirty 判定）
    const rChanged =
      view.hasSessions &&
      (refreshModeDraft !== (row.total_sessions != null ? 'fixed' : 'unlimited') ||
        (refreshModeDraft === 'fixed' &&
          refreshCountDraft.trim() !== String(row.total_sessions ?? '')))
    return cChanged || dChanged || bChanged || rChanged
  }

  function setMuted(mode) {
    setSilenceOpen(false)
    if (mode === row.muted) return
    onPatch({ muted: mode }, {
      successNotice:
        mode === 'none'
          ? '已解除静默'
          : mode === 'cycle'
            ? '本周期内不再提醒，下次顺延后自动恢复'
            : '已静默，可在此解除',
    })
  }

  const sunkClass =
    view.sunkReason === 'expired' ? 'cd-sunk-expired' : view.sunkReason === 'used_up' ? 'cd-sunk-usedup' : ''

  return (
    <div
      className={`bd-card bd-card-expanded ${sunkClass}`}
      style={view.sunkReason ? undefined : cardBgStyle(iconKey, colorForCard(row.id))}
    >
      <div className="cd-detail">
        <div className="cd-detail-head" onClick={onCollapse}>
          {/* 详情是终点层级：图标固定 22px、卡名固定 18px，不参与缩放（CSS 见
              .cd-detail-head 段） */}
          <div className="bd-card-title-row">
            <CardMark
              iconKey={iconKey}
              boxSize={iconKey ? 22 : undefined}
              scale={iconKey ? 22 / 28 : undefined}
            />
            <p className="bd-card-name">{view.row.name}</p>
          </div>
        </div>

        <div className="cd-meta">
          <span>
            有效期 {dotDate(row.start_date)} − {dotDate(row.end_date)} ·{' '}
            {view.status === 'expired' ? '已过期' : `剩 ${view.daysToDdl} 天`}
          </span>
        </div>

        {view.renewIncomplete && (
          <p className="cd-block-hint cd-hint-warn">
            续费信息不完整：缺少扣款日或周期，不会结算也不会提醒——请在下方续费区块补全。
          </p>
        )}

        <div className="cd-block">
          <div className="cd-block-head">
            <span>
              次数
              <span className="cd-block-sub">
                {view.hasSessions
                  ? `剩 ${row.remaining_sessions}${row.total_sessions != null ? ` / 共 ${row.total_sessions}` : ''} 次`
                  : '未开启次数能力'}
              </span>
            </span>
            <Toggle checked={view.hasSessions} onChange={handleSessionsToggle} label="次数能力开关" />
          </div>
          {enabling ? (
            <div className="cd-block-body">
              <label className="cd-field-inline">
                剩余
                <input
                  className="cd-num-input"
                  inputMode="numeric"
                  value={enableRemaining}
                  autoFocus
                  onChange={(e) => setEnableRemaining(e.target.value)}
                />
              </label>
              <div className="cd-block-actions">
                <button type="button" className="cd-mini-btn" onClick={submitEnable}>
                  保存
                </button>
                <button type="button" className="cd-mini-btn" onClick={() => setEnabling(false)}>
                  取消
                </button>
              </div>
            </div>
          ) : view.hasSessions ? (
            <div className="cd-block-body">
              <label className="cd-field-inline">
                剩余
                <input
                  className="cd-num-input"
                  inputMode="numeric"
                  value={remainingDraft}
                  onChange={(e) => setRemainingDraft(e.target.value)}
                />
              </label>
              {sessionsDirty() && (
                <div className="cd-block-actions">
                  <button type="button" className="cd-mini-btn" onClick={saveSessionDrafts}>
                    保存
                  </button>
                  <button type="button" className="cd-mini-btn" onClick={syncSessionDrafts}>
                    取消
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div className="cd-block">
          <div className="cd-block-head">
            <span>
              {renewEnabling ? (
                <>
                  自动续费
                  <span className="cd-block-sub">先选周期再选扣款日；保存后开启，有效期将与扣款日一致</span>
                </>
              ) : row.auto_renew ? (
                <>
                  自动续费
                  <span className="cd-block-sub">
                    {row.period_days != null
                      ? `每 ${row.period_days} 天`
                      : row.billing_cycle
                        ? CYCLE_LABEL[row.billing_cycle] || row.billing_cycle
                        : '周期缺失'}
                    {row.next_billing_date ? ` · 下次 ${shortDate(row.next_billing_date)} 扣款` : ''}
                    {view.hasSessions &&
                      (row.total_sessions != null
                        ? ` · 每周期刷新 ${row.total_sessions} 次`
                        : ' · 次数不自动重置')}
                  </span>
                </>
              ) : (
                '未开自动续费'
              )}
            </span>
            <Toggle
              checked={row.auto_renew}
              disabled={view.status === 'expired' && !row.auto_renew}
              onChange={handleRenewToggle}
              label="自动续费开关"
            />
          </div>
          {view.status === 'expired' && !row.auto_renew && (
            <p className="cd-block-hint">卡已过期，请先顺延有效期恢复生效，才能开启自动续费</p>
          )}
          {(row.auto_renew || renewEnabling) && (
            <div className="cd-block-body">
              {/* 先周期后日期：周期未选齐前不出现扣款日输入框（避免"先选日期再选周期"） */}
              <label className="cd-field-inline">
                周期
                <select
                  className="cd-select"
                  value={cycleDraft}
                  onChange={(e) => setCycleDraft(e.target.value)}
                >
                  <option value="" disabled={row.auto_renew && !renewEnabling}>
                    请选择
                  </option>
                  {BILLING_CYCLES.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                  <option value="fixed">固定天数</option>
                </select>
              </label>
              {cycleDraft === 'fixed' && (
                <label className="cd-field-inline">
                  固定天数
                  <input
                    className="cd-num-input"
                    inputMode="numeric"
                    placeholder="如 30"
                    value={periodDaysDraft}
                    onChange={(e) => setPeriodDaysDraft(e.target.value)}
                  />
                </label>
              )}
              {(() => {
                // 周期完备 = 已选周期，且固定天数模式下天数已填合法
                const days = Number(periodDaysDraft.trim())
                const ready =
                  cycleDraft !== '' &&
                  (cycleDraft !== 'fixed' || (/^\d+$/.test(periodDaysDraft.trim()) && days > 0))
                if (!ready) return null
                const upper = billingMaxForCycle(today, cycleDraft, days)
                return (
                  <label className="cd-field-inline">
                    下次扣款日
                    <input
                      type="date"
                      className="cd-date-input"
                      min={today}
                      max={upper ?? maxDdl}
                      value={billingDateDraft}
                      onChange={(e) => setBillingDateDraft(e.target.value)}
                    />
                  </label>
                )
              })()}
              {view.hasSessions && (
                <div className="cd-block-row">
                  <label className="cd-field-inline">
                    周期刷新次数
                    <select
                      className="cd-select"
                      value={refreshModeDraft}
                      onChange={(e) => {
                        setRefreshModeDraft(e.target.value)
                        if (e.target.value === 'unlimited') setRefreshCountDraft('')
                      }}
                    >
                      <option value="unlimited">无限</option>
                      <option value="fixed">固定次数</option>
                    </select>
                  </label>
                  {refreshModeDraft === 'fixed' && (
                    <label className="cd-field-inline">
                      每周期刷新
                      <input
                        className="cd-num-input"
                        inputMode="numeric"
                        placeholder="如 8"
                        value={refreshCountDraft}
                        onChange={(e) => setRefreshCountDraft(e.target.value)}
                      />
                    </label>
                  )}
                </div>
              )}
              {view.hasSessions && refreshModeDraft === 'unlimited' && (
                <p className="cd-field-hint">
                  无限：次数不会随周期重置，将保持当前数值（适合由外部扫描校准的次卡）；若希望每周期恢复次数，请选固定次数
                </p>
              )}
              {(renewEnabling || renewDraftDirty()) && (
                <div className="cd-block-actions">
                  <button type="button" className="cd-mini-btn" onClick={saveRenewEdit}>
                    保存
                  </button>
                  <button type="button" className="cd-mini-btn" onClick={cancelRenewEdit}>
                    取消
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="cd-actions-row">
          <span className="cd-silence-wrap" ref={silenceWrapRef}>
            <button
              type="button"
              className={`cd-mini-btn ${view.muted ? 'cd-btn-on' : ''}`}
              onClick={() => setSilenceOpen((o) => !o)}
            >
              {view.muted ? (row.muted === 'forever' ? '静默中' : '本周期静默中') : '静默'}
            </button>
            {silenceOpen && (
              <span className="cd-silence-menu">
                <button type="button" onClick={() => setMuted('none')}>不静默</button>
                {row.auto_renew && (
                  <button type="button" onClick={() => setMuted('cycle')}>本周期静默</button>
                )}
                <button type="button" onClick={() => setMuted('forever')}>静默</button>
              </span>
            )}
          </span>

          {row.auto_renew ? (
            <button
              type="button"
              className="cd-mini-btn cd-btn-dim"
              onClick={() =>
                onNotice('自动续费卡不可直接修改终止日期：请先关闭自动续费（续费区块开关），再来编辑')
              }
            >
              修改
            </button>
          ) : (
            <button type="button" className="cd-mini-btn" onClick={onEdit}>
              修改
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- 进站 alert（5.3：全站最高浮层 z 1030；一次会话只弹一次） ----------
// 2026-09-03 修订：静默从双文字按钮改为单图标点击循环（提醒 → 周期 → 永久 →
// 提醒；非续费卡两态），且点击**不关闭弹窗**——原地循环可逆，直到用户点条目
// 或「知道了」。静默后的卡保留在列表中（带静默标注），可再点回来。

function CardsEntryAlert({ views, onMute, onOpenCard, onClose }) {
  // 条目顺序在弹窗打开时冻结（修订 2026-09-03）：静默/恢复只变状态与标注，
  // 不重排、不沉底——排序键（剩余天数）在静默后会失效，不能跟随实时视图重算
  const [orderIds] = useState(() => views.map((v) => v.row.id))
  const ordered = orderIds.map((id) => views.find((v) => v.row.id === id)).filter(Boolean)
  return (
    <div className="bd-modal-backdrop cd-alert-backdrop" onClick={onClose}>
      <div className="bd-modal-card cd-alert-card" onClick={(e) => e.stopPropagation()}>
        <div className="bd-modal-head">
          <h2 className="cd-alert-title">有 {ordered.length} 张卡需要注意</h2>
        </div>
        <div className="bd-modal-scroll">
          <div className="cd-alert-list">
            {ordered.map((v) => (
              <div key={v.row.id} className="cd-alert-item" onClick={() => onOpenCard(v.row.id)}>
                <span className="cd-alert-dot" style={{ background: colorForCard(v.row.id) }} />
                <div className="cd-alert-main">
                  <p className="cd-alert-name">{v.row.name}</p>
                  <div className="cd-alert-tags">
                    {v.usedUp && <span className="cd-tag">已用完</span>}
                    {v.reminders.expiring && (
                      <span className="cd-tag">剩 {v.reminders.expiring.daysLeft} 天</span>
                    )}
                    {v.reminders.billing && (
                      <span className="cd-tag">{shortDate(v.reminders.billing.deadline)} 扣款</span>
                    )}
                    {v.muted && (
                      <span className="cd-tag cd-tag-plain">
                        {v.row.muted === 'forever' ? '永久静默' : '本周期静默'}
                      </span>
                    )}
                  </div>
                </div>
                <div className="cd-alert-acts">
                  <MuteCycleButton view={v} onCycle={onMute} className="cd-alert-mute-icon" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="bd-modal-foot">
          <div className="bd-modal-actions">
            <button type="button" className="bd-btn" onClick={onClose}>
              知道了
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- 建卡弹窗（5.5：一种卡 + 两个能力开关） ----------

function CardAddModal({ today, onClose, onCreated }) {
  const { rows } = useCardsStore()
  const [name, setName] = useState('')
  const [startDate, setStartDate] = useState(today)
  const [endDate, setEndDate] = useState('')
  const [sessionsOn, setSessionsOn] = useState(false)
  const [remaining, setRemaining] = useState('')
  const [total, setTotal] = useState('')
  const [renewOn, setRenewOn] = useState(false)
  const [billingDate, setBillingDate] = useState('')
  const [cycle, setCycle] = useState('month')
  const [periodDays, setPeriodDays] = useState('')
  // 周期刷新次数（2026-09-03 起从次数区块移入续费区块，与详情页编辑逻辑一致）：
  // 'unlimited' = 不自动重置（等扫描校准）| 'fixed' = 每周期重置为 total
  const [refreshMode, setRefreshMode] = useState('unlimited')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const minStart = startDateMin(today)
  const maxDdl = ddlMax(today)
  const trimmedName = name.trim()
  const duplicate = rows.find((r) => r.name === trimmedName)
  // 图标（v3.2）：手动指定落库 key；未指定 = 自动匹配（落库 null，展示层推导）。
  // 命中同名卡的预填边界由 resetToken 驱动（duplicate.id 变化 → 重置为该卡的
  // icon_key；离开同名 → 回到自动匹配跟随）
  const icon = useCardIconState({
    name: trimmedName,
    initialKey: duplicate ? duplicate.icon_key || null : null,
    resetToken: duplicate ? duplicate.id : null,
  })

  // PRD 5.5「同名覆盖表单预填」：命中同名卡时以它的当前状态预填表单——
  // "维持不是开启"：重录一张续费中的卡而不碰续费开关，提交后仍是续费中，
  // 不会从空白默认值出发把 auto_renew 静默改成 false（功能评审 2026-08-31 #2）。
  // 渲染期按卡片 id 调整状态（官方模式，避免 effect 级联渲染）。
  // 双向对称（复核 2026-08-31 #3）：不再命中同名卡（改名离开既有键）时回退到
  // 空白默认值——否则预填残留会被"新建"逻辑当成新卡的初始值一起提交。
  const [prefilledCardId, setPrefilledCardId] = useState(null)
  if (duplicate && duplicate.id !== prefilledCardId) {
    setPrefilledCardId(duplicate.id)
    setStartDate(duplicate.start_date)
    setEndDate(duplicate.end_date || '')
    setSessionsOn(duplicate.remaining_sessions != null)
    setRemaining(duplicate.remaining_sessions == null ? '' : String(duplicate.remaining_sessions))
    setTotal(duplicate.total_sessions == null ? '' : String(duplicate.total_sessions))
    setRefreshMode(duplicate.total_sessions != null ? 'fixed' : 'unlimited')
    setRenewOn(!!duplicate.auto_renew)
    setBillingDate(duplicate.next_billing_date || '')
    if (duplicate.period_days != null) {
      setCycle('fixed')
      setPeriodDays(String(duplicate.period_days))
    } else {
      // 周期缺失（B14 防御态）→ 空：强迫在下拉里重选补全，扣款日输入框随之渐进出现
      setCycle(duplicate.billing_cycle || '')
      setPeriodDays('')
    }
  } else if (!duplicate && prefilledCardId != null) {
    setPrefilledCardId(null)
    setStartDate(today)
    setEndDate('')
    setSessionsOn(false)
    setRemaining('')
    setTotal('')
    setRefreshMode('unlimited')
    setRenewOn(false)
    setBillingDate('')
    setCycle('')
    setPeriodDays('')
  }

  // 校验实时化（5.5）
  const errors = {}
  if (!trimmedName) errors.name = '请填写卡名'
  // 滚动窗口同理（复核 #1）：同名覆盖预填出的起始日可能已自然滑出配置 A——
  // 与既有行相同时不校验、diff-only 下也不进 payload；改动过才校验
  if (
    startDate &&
    (startDate < minStart || startDate > today) &&
    (!duplicate || startDate !== duplicate.start_date)
  ) {
    errors.startDate = `起始日期需在 ${minStart} 至 ${today} 之间`
  }
  if (!renewOn && endDate) {
    if (startDate && endDate < startDate) errors.endDate = '终止日期不能早于起始日期'
    else if (endDate > maxDdl) errors.endDate = `终止日期不能晚于 ${maxDdl}`
  }
  if (sessionsOn) {
    if (!/^\d+$/.test(remaining.trim()) || Number(remaining) <= 0) errors.remaining = '剩余次数必填且需大于 0'
  }
  // 周期刷新次数（与详情同则）：只在 续费开 + 次数能力开 + 固定次数 模式下校验
  if (renewOn && sessionsOn && refreshMode === 'fixed') {
    if (!/^\d+$/.test(total.trim()) || Number(total) <= 0) {
      errors.total = '每周期刷新次数需为大于 0 的整数'
    }
  }
  const ddlExpired = endDate !== '' && endDate < today
  if (renewOn) {
    // 先周期后日期（与详情续费区块同则）：周期未选齐不出扣款日输入框，提交守卫同序
    const days = periodDays.trim()
    if (days === '' && !cycle) {
      errors.cycle = '请选择扣款周期'
    } else if (cycle === 'fixed') {
      if (!/^\d+$/.test(days) || Number(days) <= 0) errors.periodDays = '固定天数需为正整数'
    }
    if (cycle && (cycle !== 'fixed' || periodDays.trim() !== '')) {
      const daysNum = days === '' ? undefined : Number(days)
      const upper = billingMaxForCycle(today, cycle, daysNum)
      if (!billingDate) {
        errors.billingDate = '请选择扣款日'
      } else if (billingDate < today || (upper && billingDate > upper)) {
        errors.billingDate = upper ? `扣款日需在今天至 ${upper} 之间（本周期内）` : '扣款日需不早于今天'
      }
    }
  }

  const canSubmit = Object.keys(errors).length === 0 && !submitting

  function toggleRenew(next) {
    if (next) {
      if (ddlExpired && !renewOn) return // B23：置灰拦"从关拨到开"；预填已开启的过期+续费中卡保持可交互（维持不是开启）
      setRenewOn(true)
      // 与详情续费区块同则：进入开启态先清空周期——先选周期（固定天数需再填天数），
      // 下次扣款日输入框才渐进出现
      setCycle('')
      setPeriodDays('')
      setBillingDate('')
      // 用户裁定 2026-09-03：次数能力开着 → 默认固定次数 = 剩余次数输入值
      // （开续费的直觉就是"每周期恢复到买的时候"）；已有预填的每周期次数则保留现值
      if (sessionsOn) {
        setRefreshMode('fixed')
        if (total.trim() === '') setTotal(remaining.trim())
      } else {
        setRefreshMode('unlimited')
      }
    } else {
      setRenewOn(false)
    }
  }

  // diff-only 提交契约（cards-db.md 7.3 / 预留 #7）：命中同名覆盖时只提交相对
  // 既有行变化的字段——预填保证"维持"时无需携带（杜绝 no-op 回显被当成写入意图），
  // 静默永不携带（保留库内值）。两个例外：
  // ① end_date 缺失在 POST 语义里 = 无限期物化（4-B5），不能省略表示"保留"——有值必带；
  // ② 次数字段组受 cards_count_pair 成对约束、"续费开启"受 B27 三件套约束——
  //    组内任一变化就整组携带。
  function buildSubmitPayload() {
    const prev = duplicate
    const formSessionsOn = sessionsOn
    const prevSessionsOn = prev ? prev.remaining_sessions != null : false
    const changedSessions =
      !prev ||
      formSessionsOn !== prevSessionsOn ||
      (formSessionsOn &&
        (Number(remaining) !== prev.remaining_sessions ||
          (total.trim() === '' ? null : Number(total)) !== (prev.total_sessions == null ? null : prev.total_sessions)))
    // 下拉模型：'fixed' = 合同天数；日历周期 = cycle key。互斥由"二选一"选择保证
    const formCycle = cycle === 'fixed' || cycle === '' ? null : cycle
    const formDays = cycle === 'fixed' && periodDays.trim() !== '' ? Number(periodDays) : null
    const changedRenew =
      !prev ||
      renewOn !== !!prev.auto_renew ||
      (renewOn &&
        (billingDate !== (prev.next_billing_date || '') ||
          formCycle !== (prev.billing_cycle || null) ||
          formDays !== (prev.period_days == null ? null : prev.period_days)))

    const payload = { name: trimmedName }
    if (!prev || startDate !== prev.start_date) payload.start_date = startDate
    // DDL ≡ 扣款日（用户裁定 2026-09-02）：续费开启时 end_date 由服务端跟随扣款日，
    // 表单不携带（终止日期区块在开启态展示"跟随扣款日"提示）；关闭/未开时照旧：
    // 有值带值（留空 = 无限期物化，4-B5）
    if (!renewOn && endDate) payload.end_date = endDate
    if (changedSessions) {
      if (sessionsOn) {
        payload.remaining_sessions = Number(remaining)
        payload.total_sessions = total.trim() === '' ? null : Number(total)
      } else {
        payload.remaining_sessions = null
        payload.total_sessions = null
      }
    }
    if (changedRenew) {
      payload.auto_renew = renewOn
      if (renewOn) {
        payload.next_billing_date = billingDate
        if (formDays != null) payload.period_days = formDays
        else payload.billing_cycle = formCycle
      }
    }
    // 图标（v3.2）：只在用户手动指定过时携带——merge-duplicates 语义下"未携带 =
    // 保留现值"，自动匹配是展示层推导不落库，未携带才能不覆盖库内既有选择。
    // manual 只在手动 pick 后为 true（iconKey 必非空）；「恢复自动」= manual false
    // → 不携带，库内 null → 展示层回到按名称自动匹配
    if (icon.manual) payload.icon_key = icon.iconKey
    return payload
  }

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    setError('')
    try {
      const res = await api.authorizedFetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...buildSubmitPayload(), today: todayISO() }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `保存失败（${res.status}）`)
      onCreated(body[0])
    } catch (err) {
      setError(err.message)
      setSubmitting(false)
    }
  }

  return (
    <div className="bd-modal-backdrop" onClick={submitting ? undefined : onClose}>
      <div className="bd-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="bd-modal-head">
          <h2 className="bd-modal-title">添加一张卡</h2>
          <p className="bd-modal-hint">
            一种卡 + 两个可选能力（次数 / 自动续费）。与已有卡「卡名」相同将直接覆盖那条记录的最新状态。
          </p>
          {duplicate && (
            <p className="bd-modal-hint bd-modal-hint-danger">
              已有同名卡「{duplicate.name}」：已预填它的当前状态，提交将以表单内容覆盖该记录（静默设置保留不变）。
            </p>
          )}
        </div>
        <div className="bd-modal-scroll">
        <div className="bd-field">
          <label>卡名</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：Tony-理发季卡（商户名-卡名）"
            autoFocus
          />
        </div>

        <div className="bd-field">
          <label>图标</label>
          <IconPickerField
            value={icon.iconKey}
            showAutoTag={!icon.manual}
            clearLabel={icon.manual ? '恢复自动' : null}
            onPick={icon.pick}
            onClear={icon.restoreAuto}
          />
        </div>

        <div className="cd-field-pair">
          <div className="bd-field">
            <label>起始日期</label>
            <input
              type="date"
              value={startDate}
              min={minStart}
              max={today}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className="bd-field">
            <label>{renewOn ? '终止日期（= 下次扣款日）' : '终止日期（不填 = 最长 2 年）'}</label>
            <input
              type="date"
              value={renewOn ? billingDate : endDate}
              min={startDate || minStart}
              max={maxDdl}
              disabled={renewOn}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>
        {errors.startDate && <p className="cd-field-hint cd-field-hint-error">{errors.startDate}</p>}
        {!renewOn && errors.endDate && (
          <p className="cd-field-hint cd-field-hint-error">{errors.endDate}</p>
        )}

        <div className="cd-form-block">
          <div className="cd-form-block-head">
            <span>
              次数能力
              <span className="cd-block-sub">记剩余次数；每周期刷新在自动续费区块配置</span>
            </span>
            <Toggle checked={sessionsOn} onChange={setSessionsOn} label="次数能力" />
          </div>
          {sessionsOn && (
            <div className="cd-form-block-body">
              <label className="cd-field-inline">
                剩余次数
                <input
                  className="cd-num-input"
                  inputMode="numeric"
                  value={remaining}
                  onChange={(e) => setRemaining(e.target.value)}
                />
              </label>
            </div>
          )}
          {errors.remaining && (
            <p className="cd-field-hint cd-field-hint-error">{errors.remaining}</p>
          )}
        </div>

        <div className="cd-form-block">
          <div className="cd-form-block-head">
            <span>
              自动续费
              <span className="cd-block-sub">开启后扣款日到达即自动顺延</span>
            </span>
            <Toggle checked={renewOn} disabled={ddlExpired && !renewOn} onChange={toggleRenew} label="自动续费" />
          </div>
          {ddlExpired && !renewOn && (
            <p className="cd-field-hint">终止日期已过：请先填写有效的终止日期，才能开启自动续费</p>
          )}
          {renewOn && (
            <div className="cd-form-block-body">
              {/* 先周期后日期（与详情续费区块同则）：周期未选齐前不出扣款日输入框 */}
              <label className="cd-field-inline">
                周期
                <select
                  className="cd-select"
                  value={cycle}
                  onChange={(e) => {
                    setCycle(e.target.value)
                    if (e.target.value !== 'fixed') setPeriodDays('')
                  }}
                >
                  <option value="">请选择</option>
                  {BILLING_CYCLES.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                  <option value="fixed">固定天数</option>
                </select>
              </label>
              {cycle === 'fixed' && (
                <label className="cd-field-inline">
                  固定天数
                  <input
                    className="cd-num-input"
                    inputMode="numeric"
                    placeholder="如 30"
                    value={periodDays}
                    onChange={(e) => setPeriodDays(e.target.value)}
                  />
                </label>
              )}
              {(() => {
                const days = periodDays.trim()
                const ready =
                  cycle !== '' && (cycle !== 'fixed' || (/^\d+$/.test(days) && Number(days) > 0))
                if (!ready) return null
                const upper = billingMaxForCycle(today, cycle, Number(days))
                return (
                  <label className="cd-field-inline">
                    下次扣款日
                    <input
                      type="date"
                      className="cd-date-input"
                      min={today}
                      max={upper ?? maxDdl}
                      value={billingDate}
                      onChange={(e) => setBillingDate(e.target.value)}
                    />
                  </label>
                )
              })()}
              {/* 周期刷新次数（与详情续费区块同款）：次数能力开启时可选每周期重置次数 */}
              {sessionsOn && (
                <div className="cd-block-row">
                  <label className="cd-field-inline">
                    周期刷新次数
                    <select
                      className="cd-select"
                      value={refreshMode}
                      onChange={(e) => {
                        setRefreshMode(e.target.value)
                        if (e.target.value === 'unlimited') setTotal('')
                      }}
                    >
                      <option value="unlimited">无限</option>
                      <option value="fixed">固定次数</option>
                    </select>
                  </label>
                  {refreshMode === 'fixed' && (
                    <label className="cd-field-inline">
                      每周期刷新
                      <input
                        className="cd-num-input"
                        inputMode="numeric"
                        placeholder="如 8"
                        value={total}
                        onChange={(e) => setTotal(e.target.value)}
                      />
                    </label>
                  )}
                </div>
              )}
              {sessionsOn && refreshMode === 'unlimited' && (
                <p className="cd-field-hint">
                  无限：次数不会随周期重置，将保持当前数值（适合由外部扫描校准的次卡）；若希望每周期恢复次数，请选固定次数
                </p>
              )}
              {(errors.cycle || errors.periodDays || errors.billingDate || errors.total) && (
                <p className="cd-field-hint cd-field-hint-error">
                  {errors.cycle || errors.periodDays || errors.billingDate || errors.total}
                </p>
              )}
              <p className="cd-field-hint">先选周期再选扣款日；扣款日限本周期内，保存后开启，有效期与扣款日一致。</p>
            </div>
          )}
        </div>

        </div>
        <div className="bd-modal-foot">
          {error && <div className="bd-notice bd-notice-error">{error}</div>}
          <div className="bd-modal-actions">
            <button type="button" className="bd-btn bd-btn-ghost" onClick={onClose} disabled={submitting}>
              取消
            </button>
            <button type="button" className="bd-btn" disabled={!canSubmit} onClick={handleSubmit}>
              {submitting ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- 修改弹窗（op9：改名 + 起始日等业务字段） ----------

function CardEditModal({ row, rows, today, onClose, onSaved }) {
  const [name, setName] = useState(row.name)
  const [startDate, setStartDate] = useState(row.start_date)
  const [endDate, setEndDate] = useState(row.end_date)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const minStart = startDateMin(today)
  const maxDdl = ddlMax(today)
  // B21 闸门：续费中的卡不允许在修改弹窗里直接改 DDL，
  // 与「顺延」按钮的限制保持一致（cards-db.md 第 9 节：前端置灰是唯一拦截层）
  const renewLocked = !!row.auto_renew

  const nameTrim = name.trim()
  // 改名（2026-09-02 裁定，行为对齐余额）：改成已有其他卡的 name → 保存报错
  // 「已有同名卡券」——服务端唯一性预检兜底（直调/快照过期防漏），前端先行即时反馈
  const nameTaken =
    nameTrim !== row.name && rows.some((r) => r.id !== row.id && r.name === nameTrim)

  // 图标（v3.2）：编辑预填库内 icon_key；未指定 = 自动匹配（跟随时不进 diff）
  const icon = useCardIconState({
    name: nameTrim,
    initialKey: row.icon_key || null,
    resetToken: row.id,
  })

  const errors = {}
  if (!nameTrim) errors.name = '请填写卡名'
  else if (nameTaken) errors.name = '已有同名卡券，请换一个名字'
  // 配置 A 是滚动窗口：老卡的起始日会随时间自然滑出 [今天−A, 今天]（时间流逝的
  // 必然结果，非脏数据）——未改动的起始日不校验、不进 payload（diff-only），后端
  // 也只在携带时校验；否则修改弹窗会被无关字段锁死（复核 2026-08-31 #1）
  if (startDate !== row.start_date && (startDate < minStart || startDate > today)) {
    errors.startDate = `起始日期需在 ${minStart} 至 ${today} 之间`
  }
  // 锁定时输入框本身已禁用、值不会变，这里同步跳过校验，避免死数据把提交按钮锁死
  if (!renewLocked) {
    // 终止日期手动窗口 [今天, 今天+配置B]（4-B2）；起始日交叉校验同 4-B6
    if (endDate > maxDdl) errors.endDate = `终止日期不能晚于 ${maxDdl}`
    else if (endDate < startDate) errors.endDate = '终止日期不能早于起始日期'
  }
  // 图标变化判定（diff-only）：手动态 ↔ 自动态互转、或手动换了 key 才算改过。
  // 手动态提交落库 key；自动态提交显式 null（覆盖库内手动值，回到展示层自动匹配）
  const iconChanged =
    icon.manual !== (row.icon_key != null) || (icon.manual && icon.iconKey !== row.icon_key)
  const changed =
    nameTrim !== row.name ||
    startDate !== row.start_date ||
    (!renewLocked && endDate !== row.end_date) ||
    iconChanged
  const canSubmit = changed && Object.keys(errors).length === 0 && !submitting

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    setError('')
    const patch = {}
    if (nameTrim !== row.name) patch.name = nameTrim
    if (startDate !== row.start_date) patch.start_date = startDate
    if (!renewLocked && endDate !== row.end_date) patch.end_date = endDate // 锁定时永不携带
    if (iconChanged) patch.icon_key = icon.manual ? icon.iconKey : null
    try {
      const res = await api.authorizedFetch(`/api/cards/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // today = 客户端本地日期（预留 #8 窗口口径）；CF 白名单会剥离该键
        body: JSON.stringify({ ...patch, today: todayISO() }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `保存失败（${res.status}）`)
      onSaved(body[0])
    } catch (err) {
      setError(err.message)
      setSubmitting(false)
    }
  }

  return (
    <div className="bd-modal-backdrop" onClick={submitting ? undefined : onClose}>
      <div className="bd-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="bd-modal-head">
          <h2 className="bd-modal-title">修改「{row.name}」</h2>
        </div>
        <div className="bd-modal-scroll">
        <div className="bd-field">
          <label>卡名</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：Tony-理发季卡（商户名-卡名）"
            autoFocus
          />
          {errors.name && <p className="cd-field-hint cd-field-hint-error">{errors.name}</p>}
        </div>
        <div className="bd-field">
          <label>图标</label>
          <IconPickerField
            value={icon.iconKey}
            showAutoTag={!icon.manual}
            clearLabel={icon.manual ? '恢复自动' : null}
            onPick={icon.pick}
            onClear={icon.restoreAuto}
          />
        </div>
        <div className="bd-field">
          <label>起始日期</label>
          <input
            type="date"
            value={startDate}
            min={minStart}
            max={today}
            onChange={(e) => setStartDate(e.target.value)}
          />
          {errors.startDate && <p className="cd-field-hint cd-field-hint-error">{errors.startDate}</p>}
        </div>
        <div className="bd-field">
          <label>终止日期</label>
          <input
            type="date"
            value={endDate}
            min={today}
            max={maxDdl}
            disabled={renewLocked}
            onChange={(e) => setEndDate(e.target.value)}
          />
          {renewLocked ? (
            <p className="cd-field-hint">
              自动续费卡不可直接顺延：请先在续费区块关闭自动续费，再来修改终止日期
            </p>
          ) : (
            errors.endDate && <p className="cd-field-hint cd-field-hint-error">{errors.endDate}</p>
          )}
        </div>

        </div>
        <div className="bd-modal-foot">
          {error && <div className="bd-notice bd-notice-error">{error}</div>}
          <div className="bd-modal-actions">
            <button type="button" className="bd-btn bd-btn-ghost" onClick={onClose} disabled={submitting}>
              取消
            </button>
            <button type="button" className="bd-btn" disabled={!canSubmit} onClick={handleSubmit}>
              {submitting ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- 删除确认（4-B33：动态文案，续费中强提醒） ----------

function CardDeleteModal({ row, onCancel, onConfirm }) {
  return (
    <div className="bd-modal-backdrop" onClick={onCancel}>
      <div className="bd-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="bd-modal-head">
          <h2 className="bd-modal-title">删除「{row.name}」？</h2>
          <p className="bd-modal-hint bd-modal-hint-danger">
            删除后记录整个消失；只想别吵请用静默，卡已到期会自动沉底。
            {row.auto_renew &&
              '该卡仍在自动续费中，删除只清除本地记录，不会帮你取消对应平台的续费——请先自行前往对应 App 取消，否则后续扣款将不再有任何提醒。'}
          </p>
        </div>
        <div className="bd-modal-foot">
          <div className="bd-modal-actions">
            <button type="button" className="bd-btn bd-btn-ghost" onClick={onCancel}>
              取消
            </button>
            <button type="button" className="bd-btn bd-btn-danger" onClick={onConfirm}>
              确定删除
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- 面板主体 ----------

export default function CardsPanel({ active, onActivate }) {
  const { rows, status, message, settleFailed, today, entryCandidateIds, entryHandled } =
    useCardsStore()
  const [sortKey, setSortKey] = useState('ddl')
  const [sortDir, setSortDir] = useState('asc')
  // 已过期卡筛选（默认收起）：点上方按钮才把过期卡带回顾队（沉底不变）
  const [showExpired, setShowExpired] = useState(false)
  // 三级展开（折叠 → 半展开 → 全量详情）：openId 定位卡，openLevel 定位层级
  const [openId, setOpenId] = useState(null)
  const [openLevel, setOpenLevel] = useState('semi')
  // 展示模式（2026-09-03 用户裁定）：列表（默认）/ 日历（飞书日程式月视图）。
  // 日历筛选为"选中集"且最多 5 张：卡数 ≤ 5 默认全选，超过 5 张默认不选
  // （null = 尚未初始化，等 sorted 可用后按此规则推导）
  const [viewMode, setViewMode] = useState('list')
  const [calSelected, setCalSelected] = useState(null)
  const [calDetailId, setCalDetailId] = useState(null)
  const [fabOpen, setFabOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [noticeText, setNoticeText] = useState('')
  const [noticeKind, setNoticeKind] = useState('info')
  // 进站会话（结算 / alert 候选集 / 会话标志 / "今天"）全部由 App 级的
  // initCardsSession 驱动（见 cardsStore.js）——路由往返不重置（3.3.3），
  // 本组件只做展示与交互。

  useAutoDismiss(noticeText, setNoticeText)

  function showNotice(text, kind = 'info') {
    setNoticeKind(kind)
    setNoticeText(text)
  }

  async function patchCard(id, patch, opts = {}) {
    try {
      const res = await api.authorizedFetch(`/api/cards/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // today = 客户端本地日期（预留 #8 窗口口径）；CF 白名单会剥离该键
        body: JSON.stringify({ ...patch, today: todayISO() }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `保存失败（${res.status}）`)
      upsertLocal(body[0])
      if (opts.successNotice) showNotice(opts.successNotice, 'info')
      if (opts.after) opts.after(body[0])
      return body[0]
    } catch (err) {
      showNotice(err.message, 'error')
      return null
    }
  }

  const views = useMemo(() => rows.map((r) => deriveCardView(r, today)), [rows, today])
  // 每行卡片的展示 icon（v3.2）：库内 icon_key 优先（手动指定），null 按卡名自动
  // 匹配——历史行/导入行不回填，靠展示层推导保证每张卡都有图标（cards.sql v3.2）
  const iconManifest = useIconManifest()
  const iconKeyById = useMemo(
    () =>
      Object.fromEntries(
        rows.map((r) => [r.id, r.icon_key || suggestIconKey(r.name, iconManifest)])
      ),
    [rows, iconManifest]
  )
  const sorted = useMemo(() => sortCardViews(views, sortKey, sortDir), [views, sortKey, sortDir])
  const expiredCount = useMemo(() => views.filter((v) => v.status === 'expired').length, [views])
  const visible = useMemo(
    () => (showExpired ? sorted : sorted.filter((v) => v.status !== 'expired')),
    [sorted, showExpired]
  )
  // 日历筛选选中集（最多 5 张，见 MAX_SELECTED）：null = 按卡数推导默认值
  const calDefaultSelected = () =>
    sorted.length <= 5 ? new Set(sorted.map((v) => v.row.id)) : new Set()
  const calSelectedIds = calSelected ?? calDefaultSelected()

  // 入场动画只播一次：首次逐张浮入（bd-rise，每张错后 40ms）结束后置 entered，
  // 之后折叠⇄半展开⇄全量详情的组件卸载重挂不再重放该动画——重放的起始帧
  // opacity:0 正是"展开时先空白一下再浮入"闪烁的来源（见 board.css .bd-entered）
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    if (entered || visible.length === 0) return
    const timer = setTimeout(() => setEntered(true), visible.length * 40 + 550)
    return () => clearTimeout(timer)
  }, [entered, visible.length])

  // 候选集内当前仍有提醒的卡（alert 行内静默 → 该卡失去提醒 → 实时从弹层收敛）
  const candidateViews = useMemo(
    () => views.filter((v) => entryCandidateIds.includes(v.row.id)),
    [views, entryCandidateIds]
  )
  // 2026-09-03 修订：alert 条目=候选集全集且常驻（静默后在弹窗内原地循环可逆），
  // 提醒标签由实时 view 推导；排序（最近关键日优先）在弹窗内部完成

  // 会话级去重：一次会话只弹一次（4-B37）；alert 覆盖任意激活标签（z 1030）
  const showAlert = candidateViews.length > 0 && !entryHandled

  function dismissAlert() {
    setEntryHandled()
  }

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      // 更新时间默认最新在前（desc）；到期日/名称默认升序
      setSortDir(key === 'updated' ? 'desc' : 'asc')
    }
  }

  // 三级展开控制：折叠 ⇄ 半展开（点击折叠卡/半展开卡本体）→ 全量详情（「展开修改」）
  function toggleSemiExpand(id) {
    setOpenId((cur) => (cur === id ? null : id))
    setOpenLevel('semi')
  }

  function openFullDetail(id) {
    setOpenId(id)
    setOpenLevel('full')
  }

  // 全量详情头部点击 → 回落半展开（不直接收回折叠，保留中间层）
  function backToSemi() {
    setOpenLevel('semi')
  }

  // 静默循环（提醒 → 周期静默 → 永久静默 → 提醒；非续费卡只有两态）——
  // 列表旗标（折叠/半展开）与进站提醒弹窗共用；目标状态由 MuteCycleButton 算出
  function cycleCardMute(view) {
    const mode = view.muted ? view.row.muted : 'none'
    const next = nextMuteMode(mode, view.row.auto_renew)
    patchCard(view.row.id, { muted: next }, { successNotice: muteNotice(next, view.row.auto_renew) })
  }

  function openCardFromAlert(cardId) {
    dismissAlert()
    setOpenId(cardId)
    setOpenLevel('semi')
    if (onActivate) onActivate()
  }

  // 半展开右滑「清零」= 标记用完（与详情内等价，3.6.2 普通更新）。
  // 先收回半展开再发 PATCH：清零后卡变"已用完"会沉底挪到列表尾部——若组件
  // 仍以半展开态挂载着飞出动画的残留 dragX（主内容/槽位 opacity=0、沉底无记录色），
  // 会在列表底部渲染出一张只剩「展开修改」按钮的白卡（2026-09-02 实测）。
  // 收回时机在右滑飞出动画结束之后（由 SemiExpandedCardRow 的提交超时调进来），
  // 动画完整、鬼影无从出现
  function clearSessionsFromSemi(row) {
    setOpenId(null)
    patchCard(row.id, { remaining_sessions: 0 }, { successNotice: usedUpNotice(row) })
  }

  // 半展开右滑到底 = 次数减一（剩余 1 时减到 0，同卡型清零文案提示沉底）
  function decrementSessionsFromSemi(row) {
    const next = Math.max(0, (row.remaining_sessions ?? 0) - 1)
    patchCard(row.id, { remaining_sessions: next }, {
      successNotice: next === 0 ? usedUpNotice(row) : null,
    })
  }

  function handleCreated(row) {
    upsertLocal(row)
    setAddOpen(false)
    setFabOpen(false)
    const view = deriveCardView(row, today)
    let text = `已添加「${row.name}」`
    if (view.reminders.expiring) text += ` · 剩 ${view.daysToDdl} 天，已进入到期提醒窗口` // 4-B38
    showNotice(text)
  }

  async function handleDeleteConfirmed() {
    const row = deleteTarget
    if (!row) return
    setDeleteTarget(null)
    setOpenId((cur) => (cur === row.id ? null : cur))
    removeLocal(row.id)
    const res = await api.authorizedFetch(`/api/cards/${row.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      showNotice(body.error || '删除失败', 'error')
      loadCards() // 回滚到真实状态
      return
    }
    // DELETE 与其他端点故意不对称（7.4 / 预留 #6）：恒 200，removed 由返回行数得出——
    // removed:0 = id 不存在或不属于该用户，本地乐观删除是错的，提示并重新拉取收敛
    const body = await res.json().catch(() => ({}))
    if (body.removed === 0) {
      showNotice('卡不存在或已删除', 'error')
      loadCards()
    }
  }

  function handleEditSaved(row) {
    upsertLocal(row)
    setEditTarget(null)
    showNotice('已保存')
  }

  // 展示模式分段控件：列表 ⇄ 日历（日历模式内嵌在日历工具栏复用同一实例）
  const modeSeg = (
    <div className="cd-mode-seg" role="tablist" aria-label="展示模式">
      <button
        type="button"
        className={viewMode === 'list' ? 'cd-seg-active' : ''}
        onClick={() => setViewMode('list')}
      >
        列表
      </button>
      <button
        type="button"
        className={viewMode === 'calendar' ? 'cd-seg-active' : ''}
        onClick={() => setViewMode('calendar')}
      >
        日历
      </button>
    </div>
  )

  return (
    <>
      {showAlert && (
        <CardsEntryAlert
          views={candidateViews}
          onMute={cycleCardMute}
          onOpenCard={openCardFromAlert}
          onClose={dismissAlert}
        />
      )}

      {active && viewMode === 'calendar' ? (
        <CardsCalendar
          views={sorted}
          today={today}
          selectedIds={calSelectedIds}
          onToggleCard={(id) =>
            setCalSelected((prev) => {
              const base = new Set(prev ?? calDefaultSelected())
              if (base.has(id)) {
                base.delete(id)
              } else {
                if (base.size >= 5) return base // 上限 5 张，满了不再勾选
                base.add(id)
              }
              return base
            })
          }
          onSetAll={(all) =>
            setCalSelected(
              all && sorted.length <= 5 ? new Set(sorted.map((v) => v.row.id)) : new Set()
            )
          }
          onOpenCard={(v) => setCalDetailId(v.row.id)}
          modeSeg={modeSeg}
        />
      ) : (
        <></>
      )}

      {active && viewMode === 'list' && (
        <>
          <div className="bd-sort-row">
            <button
              type="button"
              className={`bd-sort-btn ${sortKey === 'ddl' ? 'bd-sort-btn-active' : ''}`}
              onClick={() => toggleSort('ddl')}
            >
              按到期日 {sortKey === 'ddl' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
            </button>
            <button
              type="button"
              className={`bd-sort-btn ${sortKey === 'name' ? 'bd-sort-btn-active' : ''}`}
              onClick={() => toggleSort('name')}
            >
              按名称 {sortKey === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
            </button>
            <button
              type="button"
              className={`bd-sort-btn ${sortKey === 'updated' ? 'bd-sort-btn-active' : ''}`}
              onClick={() => toggleSort('updated')}
            >
              按更新时间 {sortKey === 'updated' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
            </button>
            {modeSeg}
          </div>

          <div className="bd-zero-row">
            <label className="bd-toggle">
              <input
                type="checkbox"
                className="bd-toggle-input"
                checked={showExpired}
                onChange={() => {
                  // 关闭开关时，若当前展开的正是过期卡，一并收起（它将从列表消失）
                  if (showExpired) {
                    const openView = views.find((w) => w.row.id === openId)
                    if (openView && openView.status === 'expired') setOpenId(null)
                  }
                  setShowExpired(!showExpired)
                }}
              />
              <span className="bd-toggle-track" aria-hidden="true" />
              <span className="bd-toggle-label">展示已过期的卡片（{expiredCount}）</span>
            </label>
          </div>

          <div
            className={`bd-list${entered ? ' bd-entered' : ''}`}
            onClick={(e) => {
              // 点空白处（卡行之外——层间距/顶部提示条等）→ 所有卡收回折叠态；
              // 点在卡上（.bd-row 内）走卡片自身的展开/收回逻辑，不在此处理
              if (e.target.closest('.bd-row')) return
              setOpenId(null)
            }}
          >
            {settleFailed && (
              <div className="bd-notice">部分数据可能未及时刷新，请稍后重新打开</div>
            )}
            {noticeText && (
              <div className={`bd-notice ${noticeKind === 'error' ? 'bd-notice-error' : ''}`}>{noticeText}</div>
            )}

            {status === 'pending' && rows.length === 0 && (
              <div className="bd-status-line">
                <span className="bd-dot bd-dot-pending" />
                正在加载会员卡…
              </div>
            )}
            {status === 'error' && (
              <div className="bd-notice bd-notice-error">加载会员卡失败：{message}</div>
            )}
            {status === 'ok' && rows.length === 0 && (
              <div className="bd-notice">
                还没有卡数据。点右下角「+」增加一条，或去
                <Link to="/app/cards-import">批量增加会员卡</Link>
                页面提交一批。
              </div>
            )}
            {status !== 'error' && rows.length > 0 && visible.length === 0 && (
              <div className="bd-notice">
                当前列表只显示未过期的卡——打开上方「展示已过期的卡片」开关展开过期卡。
              </div>
            )}

            {visible.map((v, idx) => {
              if (openId === v.row.id && openLevel === 'full') {
                return (
                  <ExpandedCardRow key={v.row.id}>
                    <CardDetail
                      view={v}
                      iconKey={iconKeyById[v.row.id]}
                      today={today}
                      onPatch={(patch, opts) => patchCard(v.row.id, patch, opts)}
                      onNotice={showNotice}
                      onEdit={() => setEditTarget(v.row)}
                      onCollapse={backToSemi}
                    />
                  </ExpandedCardRow>
                )
              }
              if (openId === v.row.id) {
                return (
                  <SemiExpandedCardRow
                    key={v.row.id}
                    view={v}
                    iconKey={iconKeyById[v.row.id]}
                    stackIndex={idx}
                    onDelete={(row) => setDeleteTarget(row)}
                    onClear={clearSessionsFromSemi}
                    onDecrement={decrementSessionsFromSemi}
                    onFullyExpand={openFullDetail}
                    onCollapse={toggleSemiExpand}
                    onCycleMute={cycleCardMute}
                  />
                )
              }
              return (
                <CardRow
                  key={v.row.id}
                  view={v}
                  iconKey={iconKeyById[v.row.id]}
                  stackIndex={idx}
                  stackTotal={visible.length}
                  onToggleExpand={toggleSemiExpand}
                  onCycleMute={cycleCardMute}
                />
              )
            })}
          </div>
            </>
          )}

          {active && (
          <div className="bd-fab-wrap">
            {fabOpen && (
              <>
                <div className="bd-fab-backdrop" onClick={() => setFabOpen(false)} />
                <div className="bd-fab-menu">
                  <Link className="bd-fab-menu-item" to="/app/cards-import" onClick={() => setFabOpen(false)}>
                    批量增加
                  </Link>
                  <button
                    type="button"
                    className="bd-fab-menu-item"
                    onClick={() => {
                      setFabOpen(false)
                      setAddOpen(true)
                    }}
                  >
                    增加一条
                  </button>
                </div>
              </>
            )}
            <button
              type="button"
              className={`bd-fab-btn ${fabOpen ? 'bd-fab-btn-open' : ''}`}
              onClick={() => setFabOpen((v) => !v)}
              aria-label="新增卡"
            >
              +
            </button>
          </div>
          )}

      {/* 日历模式的详情弹窗：只读（2），不允许修改——改卡走列表模式的详情态 */}
      {calDetailId &&
        (() => {
          const v = views.find((w) => w.row.id === calDetailId)
          if (!v) return null
          return (
            <div className="bd-modal-backdrop" onClick={() => setCalDetailId(null)}>
              <div className="bd-modal-card cd-cal-detail" onClick={(e) => e.stopPropagation()}>
                <CardReadonlyDetail view={v} today={today} />
              </div>
            </div>
          )
        })()}

      {addOpen && <CardAddModal today={today} onClose={() => setAddOpen(false)} onCreated={handleCreated} />}
      {editTarget && (
        <CardEditModal
          row={rows.find((r) => r.id === editTarget.id) || editTarget}
          rows={rows}
          today={today}
          onClose={() => setEditTarget(null)}
          onSaved={handleEditSaved}
        />
      )}
      {deleteTarget && (
        <CardDeleteModal
          row={rows.find((r) => r.id === deleteTarget.id) || deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDeleteConfirmed}
        />
      )}
    </>
  )
}