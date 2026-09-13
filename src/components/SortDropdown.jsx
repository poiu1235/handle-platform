import { useEffect, useRef, useState } from 'react'

// 排序下拉（2026-09-13 用户裁定：余额 / 会员页三枚排序按钮折叠为一个下拉框，
// 样式对照会员页 .cd-select 下拉）。按钮文案 = 当前项 + 方向箭头（↑ 升序 /
// ↓ 降序，随排序状态变化，位置恒在文案后面）；点开菜单后——选不同项 = 切换
// 排序键，选同一项 = 换向。换向 / 切换的落地全部交给 onSelect(key)（页面现有
// toggleSort 语义原样复用，默认排序方向不归本组件管）。
//
// 用原生 <select> 做不到「重选同一项触发」——change 事件只在值变化时发出，
// 故为自绘浮层菜单：点按钮开合 / 点外部或 Escape 收起。

export default function SortDropdown({ options, activeKey, dir, onSelect }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  // 开着时：点外部 / Escape 收起（mousedown 兼容触屏的合成事件）
  useEffect(() => {
    if (!open) return
    const onDocDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const active = options.find((o) => o.key === activeKey)
  const arrow = dir === 'asc' ? '↑' : '↓'

  return (
    <div className="bd-sort-dd" ref={wrapRef}>
      <button
        type="button"
        className={`bd-sort-dd-btn${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {active ? `${active.label} ${arrow}` : '排序'}
      </button>
      {open && (
        <div className="bd-sort-dd-menu" role="listbox">
          {options.map((o) => {
            const on = o.key === activeKey
            return (
              <button
                key={o.key}
                type="button"
                role="option"
                aria-selected={on}
                className={`bd-sort-dd-item${on ? ' on' : ''}`}
                onClick={() => {
                  onSelect(o.key)
                  setOpen(false)
                }}
              >
                {on ? `${o.label} ${arrow}` : o.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
