import { useEffect, useState } from 'react'
import { loadIconManifest } from './iconMatch'

// 图标清单的 React 接入：组件里一行拿到 /icon-manifest.json 内容。
// loadIconManifest 自带模块级缓存（整个页面生命周期只请求一次），多处挂载
// 不会产生重复请求；余额（Hello.jsx）与会员（CardsPanel.jsx）共用这一份。
export function useIconManifest() {
  const [manifest, setManifest] = useState([])

  useEffect(() => {
    let cancelled = false
    loadIconManifest().then((list) => {
      if (!cancelled) setManifest(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return manifest
}
