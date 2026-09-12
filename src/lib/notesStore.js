import { useSyncExternalStore } from 'react'
import { authorizedFetch } from './apiClient'
import { isCleared, todayISO } from '../../shared/notesDomain.js'

// 便利贴 store（PRD 8.7，形态对照 cardsStore）：模块级单例 + useSyncExternalStore。
// 进站全量拉取 + 清除扫描 + 乐观更新；没有数据轮询——v3 状态全派生（8.2），
// store 只存原始行，today 由 tickDate() 维护，跨零点重算派生态即可。
// 会话语义比 cards 轻：拉取与跨天检测都由面板激活期驱动（NotesPanel useEffect），
// 不在 App 层挂全局会话——状态只在「看板子」的那一刻才有意义。

let state = {
  rows: [],
  status: 'idle', // idle | pending | ok | error
  message: '',
  today: todayISO(),
  nowMs: Date.now(), // 手动完成行 30 天清除的精确判定时钟（随 tickDate 每 ≥60s 刷新）
}

const listeners = new Set()
function emit() {
  for (const fn of listeners) fn()
}
function set(partial) {
  state = { ...state, ...partial }
  emit()
}
export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function getNotesSnapshot() {
  return state
}
export function useNotesStore() {
  return useSyncExternalStore(subscribe, getNotesSnapshot)
}

let loading = false

// 全量拉取 + 清除扫描（8.5）：合入后派生已过清除时刻的行 → 批量物理删除
// （幂等，多端任一端触发即可；失败不影响本次展示——读路径本就过滤）
export async function loadNotes() {
  if (loading) return
  loading = true
  if (state.status === 'idle') set({ status: 'pending' })
  try {
    const res = await authorizedFetch('/api/notes')
    const body = await res.json().catch(() => [])
    if (!res.ok) throw new Error(body.error || `拉取失败（${res.status}）`)

    let rows = Array.isArray(body) ? body : []
    const nowMs = Date.now()
    const cleared = rows.filter((r) => isCleared(r, state.today, nowMs))
    if (cleared.length > 0) {
      const ids = cleared.map((r) => r.id).join(',')
      const del = await authorizedFetch(`/api/notes?id=${encodeURIComponent(`in.(${ids})`)}`, {
        method: 'DELETE',
      })
      if (del.ok) {
        const gone = new Set(cleared.map((r) => r.id))
        rows = rows.filter((r) => !gone.has(r.id))
      }
    }
    set({ rows, status: 'ok', message: '', nowMs: Date.now() })
  } catch (err) {
    // 失败降级（对照 cardsStore）：有数据 → 保留并轻提示；无数据 → error 态
    if (state.rows.length > 0) set({ status: 'ok', message: err.message })
    else set({ status: 'error', message: err.message })
  } finally {
    loading = false
  }
}

// 跨零点：本地日历换天即换 state.today，派生态（倒计时/过期/归档）随之整体重算。
// 至多每分钟广播一次（面板 30s 间隔调用去重），nowMs 供手动完成行的清除判定
export function tickDate() {
  const nowMs = Date.now()
  const t = todayISO(new Date(nowMs))
  if (t !== state.today || nowMs - state.nowMs >= 60_000) set({ today: t, nowMs })
}

// 乐观落库：POST / PATCH 的 return=representation 单行就地 upsert（不重拉列表）
export function upsertLocal(row) {
  if (!row || !row.id) return
  const exists = state.rows.some((r) => r.id === row.id)
  const rows = exists ? state.rows.map((r) => (r.id === row.id ? row : r)) : [row, ...state.rows]
  set({ rows })
}

// 本地先删；DELETE 返回 removed:0（他端已删）由调用方 loadNotes() 收敛
export function removeLocal(id) {
  set({ rows: state.rows.filter((r) => r.id !== id) })
}
