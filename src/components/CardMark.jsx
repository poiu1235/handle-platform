import { useEffect, useState } from 'react'

// 卡片名称前的小标记：有 icon_key 就显示 logo，没有/加载失败则回退成菱形点。
// 余额（Hello.jsx）与会员（CardsPanel.jsx）列表共用；菱形点样式见 board.css
// .bd-card-mark（沉底卡有各自的灰化覆盖），图标样式见 .bd-card-icon。
//
// 两种尺寸模式（二选一）：
//   boxSize / scale — 余额卡专用（稳定版结构）：图片恒按 40px 最大号排版，用
//     transform: scale(scale) 做"从小变大"（纯合成层动画），外面套一层
//     boxSize×boxSize、overflow:hidden 的容器负责占位和裁切。注意 transform
//     不改变布局尺寸——img 元素在 DevTools 里恒为 40×40，缩放只体现在渲染上。
//   size — 直接按目标 px 渲染 img（width/height 内联覆盖 40px 基础值）：
//     会员卡专用（2026-09-06 裁定：会员侧 img 元素尺寸必须等于目标尺寸，
//     不允许恒 40×40）。边框观感对齐余额展开态：box-shadow 按 size/40 等比
//     换算 + 同款 overflow:hidden 裁切盒（.bd-card-icon-box）。会员折叠⇄半
//     展开的"从小变大"动效由内联 width/height transition 承担（图片没有文字
//     重排问题），不动余额依赖的样式结构。
export default function CardMark({ iconKey, size, boxSize, scale }) {
  const [failed, setFailed] = useState(false)

  // iconKey 变化时（比如切换到另一条记录复用了同一实例的极少数情况）重置失败态
  useEffect(() => {
    setFailed(false)
  }, [iconKey])

  if (iconKey && !failed) {
    if (size != null) {
      // 边框观感对齐余额展开态（2026-09-06 裁定）：余额的高光边声明在 40px
      // 元素上、随 transform 等比缩放、且被 overflow:hidden 的盒子裁掉外溢——
      // 这里按 size/40 等比换算同一组 box-shadow，并套同款裁切盒，会员图标在
      // 任意尺寸下的边框比例与余额一致（内联覆盖 .bd-card-icon 的固定值声明）
      const k = size / 40
      const img = (
        <img
          className="bd-card-icon"
          src={`/small_icon/${encodeURIComponent(iconKey)}.png`}
          alt=""
          style={{
            width: size,
            height: size,
            // 内联 transition 覆盖 .bd-card-icon 的 transform 过渡（那是余额
            // 裁切结构用的）——会员侧用宽高过渡做"从小变大"
            transition: 'width 0.32s var(--bd-ease), height 0.32s var(--bd-ease)',
            boxShadow: `${-0.5 * k}px ${-0.5 * k}px ${1.5 * k}px rgba(255, 255, 255, 0.95), ${0.5 * k}px ${0.5 * k}px ${1.5 * k}px rgba(255, 255, 255, 0.45), 0 0 0 ${k}px rgba(255, 255, 255, 0.3)`,
          }}
          onError={() => setFailed(true)}
        />
      )
      // 同款 overflow:hidden 裁切盒（复用余额的 .bd-card-icon-box 类，含
      // margin-right 8px 与宽高过渡），裁掉光晕外溢——观感与余额一致
      return (
        <span className="bd-card-icon-box" style={{ width: size, height: size }}>
          {img}
        </span>
      )
    }
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
