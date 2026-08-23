import { useEffect } from 'react'

const DEFAULT_DELAY_MS = 4000

// 让一条提示（notice / error）展示一段时间后自动消失，而不必等用户做下一次操作
// 才会被覆盖掉。setValue 是 useState 返回的 setter，React 保证它在多次渲染之间
// 引用稳定，所以放进依赖数组不会导致每次渲染都重新计时——只有 value 真正变化
// （从空变有内容，或换了一条新文案）才会重新起一个新的定时器。
export function useAutoDismiss(value, setValue, delay = DEFAULT_DELAY_MS) {
  useEffect(() => {
    if (!value) return
    const timer = setTimeout(() => setValue(''), delay)
    return () => clearTimeout(timer)
  }, [value, setValue, delay])
}