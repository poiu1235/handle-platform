import { useEffect, useState } from 'react'

// 卡片名称前的小标记：有 icon_key 就显示 logo，没有/加载失败则回退成菱形点。
// 余额（Hello.jsx）与会员（CardsPanel.jsx）列表共用；菱形点样式见 board.css
// .bd-card-mark（沉底卡有各自的灰化覆盖），图标样式见 .bd-card-icon。
//
// boxSize / scale 只在展开态那张可交互卡片上用得到（见 SwipeableBalanceCard 下方的
// 说明）：图片本身永远按 40px 最大号排版，用 transform: scale(scale) 做"从小变大"，
// 外面套一层 boxSize×boxSize、overflow:hidden 的容器负责占位和裁切。静态预览卡片
// （bd-card-static，不参与展开/收起）不传这两个 prop，走原来的固定尺寸渲染。
export default function CardMark({ iconKey, boxSize, scale }) {
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
