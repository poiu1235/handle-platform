// 会员模块级状态 + 进站会话控制器（3.3.3 / 4-B37 / 4-B29）。
// Hello 首页的会员面板与独立路由的批量导入页共享同一份 rows——导入预览分类
// 用进站时已加载的全量快照判定，0 次额外请求（src/cards-db.md 1.2 请求预算）。
//
// 会话必须挂在模块层（= App 根 / 页面加载级别）而不是路由组件上：/app 与
// /app/cards-import 是兄弟路由，往返会卸载重挂路由组件，而 PRD 3.3.3 明确
// "路由跳转不是进站"——若会话随组件生死，导入返回会被误判为新进站（重新
// 结算 + 把导入产生的提醒当场弹成 alert，违反 4-B29）。页面刷新 = 根组件
// 重新挂载 = 真进站，模块态随之归零，符合定义。

import { useSyncExternalStore } from 'react'
import * as api from './apiClient'
import { buildAlert, deriveCardView, todayISO } from './cardsDomain'

let state = {
  rows: [],
  status: 'idle', // idle | pending | ok | error
  message: '',
  settleFailed: false,
  today: todayISO(), // 会话内"今天"（跨天由 checkDay 推进，3.7 本地时区）
  entryCandidateIds: [], // 进站结算落定时刻锁定的提醒候选集（3.3.3 ③）
  entryHandled: false, // 会话 alert 标志：只由与 alert 的交互置位，跨天重置
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

export function getCardsSnapshot() {
  return state
}

export function useCardsStore() {
  return useSyncExternalStore(subscribe, getCardsSnapshot)
}

// 进站加载 = 结算 + 全量拉取一次完成（GET /api/cards 转发 rpc/settle_my_cards）。
// 首载失败 → error 态（无数据可渲染）；已有数据的再结算失败 → 非阻塞降级：
// 按上次已知状态渲染，置 settleFailed 供清单顶部会话级轻提示（PRD 3.3.3）。
export async function loadCards() {
  if (state.status === 'pending') return
  const hadData = state.status === 'ok'
  set({ status: 'pending' })
  try {
    // today = 客户端本地日期：结算追赶与展示层的"今天"同源（跨时区错位修复
    // 2026-09-02，见 supabase/cards.sql settle_my_cards p_today 注释）
    const res = await api.authorizedFetch(`/api/cards?today=${todayISO()}`)
    const body = await res.json().catch(() => null)
    if (!res.ok || !Array.isArray(body)) {
      throw new Error(body?.error || `加载失败（${res.status}）`)
    }
    state = { ...state, rows: body, status: 'ok', message: '', settleFailed: false }
    // 结算落定 → 锁定本次进站的提醒候选集（3.3.3：结算先于推导，alert 是
    // 进站时被动发现的产物；此后会话内的用户写入不再改变候选集——4-B38）
    const entries = buildAlert(state.rows.map((r) => deriveCardView(r, state.today)))
    state = { ...state, entryCandidateIds: entries ? entries.map((e) => e.cardId) : [] }
    emit()
  } catch (err) {
    if (hadData) {
      set({ status: 'ok', settleFailed: true })
    } else {
      set({ status: 'error', message: err.message })
    }
  }
}

// 导入提交后全量替换（import_my_cards 返回全量行，无第二次请求）。
// 不重锁候选集、不重置 handled——导入不触发结算也不触发 alert（3.7 / 4-B29），
// 提醒在下次进站（根组件挂载 / 跨天）统一计算。
export function applyRows(rows) {
  set({ rows, settleFailed: false })
}

// 单卡写入后就地更新（POST/PATCH return=representation，不重拉列表）
export function upsertLocal(row) {
  if (!row || !row.id) return
  const exists = state.rows.some((r) => r.id === row.id)
  set({ rows: exists ? state.rows.map((r) => (r.id === row.id ? row : r)) : [...state.rows, row] })
}

export function removeLocal(id) {
  set({ rows: state.rows.filter((r) => r.id !== id) })
}

// 与 alert 的交互（知道了 / 行内静默 / 点条目进详情）→ 本会话不再弹
export function setEntryHandled() {
  set({ entryHandled: true })
}

// ---------------------------------------------------------------------------
// 进站会话（4-B37）：根组件挂载 / 同会话跨天回焦（focus）/ 可见态每 30 分钟
// 轮询检测跨天（不可见不轮询）。由 App 根在登录态就绪后调用一次；
// 多标签页各自独立维持（不做跨 tab 同步）；内存标志不落地存储。
// ---------------------------------------------------------------------------

let sessionStarted = false
let sessionUserId = null
let lastSeenDate = null

export function initCardsSession(userId) {
  if (sessionUserId !== userId) {
    // 首次登录 / 换账号：整仓重置，绝不把上一个账号的快照带给下一个
    state = {
      rows: [],
      status: 'idle',
      message: '',
      settleFailed: false,
      today: todayISO(),
      entryCandidateIds: [],
      entryHandled: false,
    }
    sessionUserId = userId
    emit()
  }

  if (sessionStarted) {
    // 会话已存活（重登录）：重新拉取即可；不重置会话标志
    loadCards()
    return
  }
  sessionStarted = true
  lastSeenDate = todayISO()

  const checkDay = () => {
    const now = todayISO()
    if (now === lastSeenDate) return
    lastSeenDate = now
    // 跨天 = 新进站（3.3.3）：会话 alert 标志重置 + 重新结算
    set({ today: now, entryHandled: false })
    loadCards()
  }
  const onVisibility = () => {
    if (document.visibilityState === 'visible') checkDay()
  }
  window.addEventListener('focus', checkDay)
  document.addEventListener('visibilitychange', onVisibility)
  window.setInterval(() => {
    if (document.visibilityState === 'visible') checkDay()
  }, 30 * 60 * 1000)

  loadCards()
}
