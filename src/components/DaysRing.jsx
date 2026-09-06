import { useId } from 'react'

// 环形倒计时（设计稿样式：浅色轨道 + 渐变进度弧〔圆角端点、柔和光晕〕+
// 居中大数字 / 小标签）。纯展示、零外部样式依赖：布局与配色全部走内联样式
// 与 SVG，放进任何面板即可用，文字继承外层字体（board 里是 PT Sans 体系）。
//
// 方案：SVG 双 circle 叠加——底层轨道实色整圆，上层进度弧用 stroke-dasharray =
// 周长、stroke-dashoffset = 周长 ×(1-比例) 控制弧长，-90° 起点转到 12 点钟方向，
// 顺时针生长；渐变描边由 <linearGradient> 提供（每实例 useId 防止 id 撞车）。
// 数字动态调整时只有 dashoffset 在变，CSS transition 让弧长平滑伸缩，
// 数字与标签直接随 props 重渲——没有逐帧计数动画的复杂度，观感已经连续。
//
// props：
//   value   当前数值（天数；带小数会四舍五入显示，弧长按 value/max 计算）
//   max     满环对应的上限（默认 30；value 超界自动钳制到 [0, max]，
//           max <= 0 视为满环——没有周期概念时宁多勿少；传 null = 周期不可知，
//           只画轨道不画进度弧，数字照常展示）
//   label   数字下方的小字（默认 "Days Left"；传空串/不传 = 只显示数字，
//           2026-09-06 用户裁定：卡内小尺寸环不带"天"字，数字即天数）
//   size    外径 px（默认 96）；stroke 弧宽 px（默认 10）
//   from/to 进度弧渐变两端色（默认设计稿的浅橙→深橙）；track 轨道色
//   glow    是否开启进度弧的暖色光晕（默认 true）
//   glowColor 光晕颜色（随 to 色调配套传，默认橙色系）
//
// 用法：
//   <DaysRing value={3} max={30} />
//   <DaysRing value={daysLeft} max={periodDays} label="剩余天数" size={120} />
export default function DaysRing({
  value,
  max = 30,
  label = 'Days Left',
  size = 96,
  stroke = 10,
  from = '#F8B57C',
  to = '#EE7B3F',
  track = '#FBEEDF',
  glow = true,
  glowColor = 'rgba(238, 123, 63, 0.35)',
  className = '',
}) {
  const gid = useId()
  const center = size / 2
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r
  const shown = Math.max(0, Math.round(value))
  const fraction = max == null ? null : max > 0 ? Math.max(0, Math.min(1, value / max)) : 1
  // 数字随位数自动降档：1~2 位大字号，3 位起收一档，避免顶出环内空间
  const numSize = Math.round(size * (String(shown).length >= 3 ? 0.3 : 0.42))
  return (
    <div
      className={className}
      style={{ position: 'relative', width: size, height: size, flex: 'none' }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${shown} ${label}`}
      >
        <defs>
          <linearGradient id={gid} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={from} />
            <stop offset="100%" stopColor={to} />
          </linearGradient>
        </defs>
        <circle cx={center} cy={center} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        {fraction != null && (
          <circle
            cx={center}
            cy={center}
            r={r}
            fill="none"
            stroke={`url(#${gid})`}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - fraction)}
            transform={`rotate(-90 ${center} ${center})`}
            style={{
              transition: 'stroke-dashoffset 0.5s ease',
              filter: glow ? `drop-shadow(0 2px 6px ${glowColor})` : undefined,
            }}
          />
        )}
      </svg>
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: Math.max(2, Math.round(size * 0.025)),
          pointerEvents: 'none',
        }}
      >
        <span
          style={{
            fontSize: numSize,
            fontWeight: 700,
            lineHeight: 1,
            color: 'var(--au-text, #1a1a1a)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {shown}
        </span>
        {label ? (
          <span
            style={{
              fontSize: Math.max(10, Math.round(size * 0.125)),
              fontWeight: 700,
              color: 'var(--au-text-2, #646464)',
            }}
          >
            {label}
          </span>
        ) : null}
      </div>
    </div>
  )
}
