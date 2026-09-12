// ============================================================
// 便利贴面板（notes · PRD notes-wall-prd-v3 / 8.7）
// 四分区：置顶（品牌蓝容器，四分区中唯一带色块容器，D11）/ 主时间线（创建
// 倒序混排，D12）/ 已过期折叠域 / 已完成折叠域（默认收起，空分区整区隐藏）。
// 状态全派生（shared/notesDomain.js）——过期、归档、清除由「今天的本地日历」
// 算出，组件只渲染派生结果；跨零点 / 回焦由 tickDate + loadNotes 重算重拉。
// 写操作惯例（对照 CardsPanel）：请求成功 → upsertLocal 乐观落 store；
// 失败 → notice（useAutoDismiss 4s 自灭）。
// 样式：board.css 末尾 nt- 前缀段；复用 bd-modal / bd-btn / bd-notice / bd-fab。
// ============================================================

import { useEffect, useMemo, useState } from 'react'
import {
  loadNotes,
  removeLocal,
  tickDate,
  upsertLocal,
  useNotesStore,
} from '../lib/notesStore'
import { authorizedFetch } from '../lib/apiClient'
import { useAutoDismiss } from '../lib/useAutoDismiss'
import iconCheck from '../assets/icons/check-one.svg'
import iconDelete from '../assets/icons/delete.svg'
import iconEditor from '../assets/icons/editor.svg'
import iconPin from '../assets/icons/pin.svg'
import iconPinOff from '../assets/icons/pin-off.svg'
import { CONTENT_MAX, DUE_MAX_LOOKAHEAD_DAYS } from '../../shared/notesConfig.js'
import {
  addDaysISO,
  agoText,
  archiveDayOf,
  countdownOf,
  deadlineOf,
  deriveState,
  expiredDays,
  hashTilt,
  isCleared,
  localDayOf,
  matchesQuery,
  shortDate,
  sortCreatedDesc,
  sortForDone,
  sortForExpired,
  sortForIdeaFilter,
  sortForMemoFilter,
  splitHighlight,
  todayISO,
} from '../../shared/notesDomain.js'

const FOLD_KEY = 'notes-folds-v1' // 折叠记忆（置顶默认展开，已过期/已完成默认收起，D11/D10）
const KIND_KEY = 'notes-last-kind' // 新建默认类型：首次「备忘」，之后记住上次（9.2-2）

const KIND_LABELS = { memo: '备忘', idea: '灵感' }

function readFolds() {
  try {
    const saved = JSON.parse(localStorage.getItem(FOLD_KEY))
    if (saved && typeof saved === 'object') {
      return { pin: true, expired: false, done: false, ...saved }
    }
  } catch {
    /* 损坏即用默认 */
  }
  return { pin: true, expired: false, done: false }
}

export default function NotesPanel({ active }) {
  const { rows, status, message, today, nowMs } = useNotesStore()
  const [notice, setNotice] = useState('')
  useAutoDismiss(notice, setNotice)
  const [expandedId, setExpandedId] = useState(null) // 同时只一张展开
  const [folds, setFolds] = useState(readFolds)
  const [kindFilter, setKindFilter] = useState('all') // all | memo | idea（工具行筛选）
  const [memoDir, setMemoDir] = useState('near') // 仅备忘排序方向：near（截止日由近到远，默认）| far（由远到近）
  const [ideaDir, setIdeaDir] = useState('new') // 仅灵感排序方向：new（创建从新到旧，默认）| old（从旧到新）
  const [view, setView] = useState('list') // list（默认）/ cal（日历，对照会员页展示模式）
  const [query, setQuery] = useState('') // 列表视图搜索词（纯前端过滤，切换零请求）
  const [calMonth, setCalMonth] = useState(() => todayISO().slice(0, 7)) // 日历当前月 YYYY-MM
  const [calPeek, setCalPeek] = useState(null) // 日历条目只读弹层（2026-09-12：不再跳回列表）
  const [calDayPeek, setCalDayPeek] = useState(null) // 日历格折叠剩余条目的悬浮列表
  const [composer, setComposer] = useState(null) // { id?, kind, content, due } | null
  const [confirmDel, setConfirmDel] = useState(null) // row | null
  const [saving, setSaving] = useState(false)

  // 常驻挂载（对照 CardsPanel）：进站即拉取，标签徽章计数立即可见；
  // 跨零点 / 回焦持续重算，不随标签切换启停（便利贴是日历日驱动的页面）
  useEffect(() => {
    loadNotes()
    const timer = setInterval(tickDate, 30_000)
    const onWake = () => {
      if (document.hidden) return
      tickDate()
      loadNotes()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
    }
  }, [])

  // 派生 + 四分区（纯函数全部在 shared/notesDomain.js，切换零请求）。
  // 类型筛选在派生前先过滤——「仅灵感」时已过期/已完成域自然清空、整区隐藏。
  // 筛选排序（2026-09-12 用户裁定）：仅备忘 = 四个备忘模块各自按截止日排序
  // （今天到期 → 明天 → …，无日期垫底），方向由 memoDir 控制、再点反向；
  // 仅灵感 = 灵感模块（Pin + 时间线）按创建时间排序（最新在前，方向可反）。
  // 「全部」视图保持各域默认规则（创建倒序 / 过期最快被收走最前 / 最近处理在上）
  const zones = useMemo(() => {
    const views = rows
      .filter((row) => !isCleared(row, today, nowMs))
      .filter((row) => kindFilter === 'all' || row.kind === kindFilter)
      .map((row) => ({ row, state: deriveState(row, today) }))

    if (kindFilter === 'memo') {
      return {
        pin: sortForMemoFilter(views.filter((v) => v.state === 'normal' && v.row.pinned), memoDir),
        timeline: sortForMemoFilter(views.filter((v) => v.state === 'normal' && !v.row.pinned), memoDir),
        expired: sortForMemoFilter(views.filter((v) => v.state === 'expired'), memoDir),
        done: sortForMemoFilter(views.filter((v) => v.state === 'done-manual' || v.state === 'done-auto'), memoDir),
      }
    }
    if (kindFilter === 'idea') {
      const sortIdeas = (list) => sortForIdeaFilter(list, ideaDir === 'far' ? 'old' : 'new')
      return {
        pin: sortIdeas(views.filter((v) => v.state === 'normal' && v.row.pinned)),
        timeline: sortIdeas(views.filter((v) => v.state === 'normal' && !v.row.pinned)),
        expired: [],
        done: [],
      }
    }
    return {
      pin: sortCreatedDesc(views.filter((v) => v.state === 'normal' && v.row.pinned)),
      timeline: sortCreatedDesc(views.filter((v) => v.state === 'normal' && !v.row.pinned)),
      expired: sortForExpired(views.filter((v) => v.state === 'expired'), today),
      done: sortForDone(views.filter((v) => v.state === 'done-manual' || v.state === 'done-auto')),
    }
  }, [rows, today, nowMs, kindFilter, memoDir, ideaDir])

  // 搜索结果（2026-09-13，PRD 4.6）：类型筛选之后做 content 大小写不敏感子串
  // 匹配，四域统一平铺、创建时间倒序——分区是浏览结构，搜索是查找结构。
  // 已过期 / 已完成一并搜索（找回旧东西是主场景）；query 为空返回 null = 走四分区
  const searchResults = useMemo(() => {
    const q = query.trim()
    if (!q) return null
    const views = rows
      .filter((row) => !isCleared(row, today, nowMs))
      .filter((row) => kindFilter === 'all' || row.kind === kindFilter)
      .filter((row) => matchesQuery(row.content, q))
      .map((row) => ({ row, state: deriveState(row, today) }))
    return sortCreatedDesc(views)
  }, [rows, today, nowMs, kindFilter, query])

  // 日历数据（2026-09-12 用户裁定：灵感也进日历）：备忘按截止日落位（仅正常态），
  // 灵感按创建日落位（无过期概念，全部展示）；灵感白条、备忘黄条样式区分
  const calItems = useMemo(() => {
    const map = {}
    for (const row of rows) {
      if (isCleared(row, today, nowMs)) continue
      if (row.kind === 'memo') {
        if (kindFilter === 'idea') continue
        if (deriveState(row, today) !== 'normal') continue
        const day = deadlineOf(row)
        if (!day.startsWith(calMonth)) continue
        ;(map[day] ??= []).push(row)
      } else {
        if (kindFilter === 'memo') continue
        const day = localDayOf(row.created_at)
        if (!day.startsWith(calMonth)) continue
        ;(map[day] ??= []).push(row)
      }
    }
    for (const list of Object.values(map)) {
      list.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    }
    return map
  }, [rows, today, nowMs, calMonth, kindFilter])

  // 月网格：周一起，UTC 口径（日期均为 ISO 字符串）
  const calCells = useMemo(() => {
    const [y, m] = calMonth.split('-').map(Number)
    const offset = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
    const cells = []
    for (let i = 0; i < offset; i++) cells.push(null)
    for (let d = 1; d <= days; d++) cells.push(`${calMonth}-${String(d).padStart(2, '0')}`)
    while (cells.length % 7 !== 0) cells.push(null)
    return cells
  }, [calMonth])

  function toggleFold(key) {
    setFolds((f) => {
      const next = { ...f, [key]: !f[key] }
      localStorage.setItem(FOLD_KEY, JSON.stringify(next))
      return next
    })
  }

  // 筛选段按钮 = 筛选 + 排序开关（2026-09-12 用户裁定）：第一下进入筛选即按字段
  // 排序（备忘 = 截止日由近到远，灵感 = 创建从新到旧），再点一下各模块反向
  function clickFilter(kind) {
    if (kindFilter !== kind) {
      setKindFilter(kind)
      setMemoDir('near')
      setIdeaDir('new')
      return
    }
    if (kind === 'memo') setMemoDir((d) => (d === 'near' ? 'far' : 'near'))
    else if (kind === 'idea') setIdeaDir((d) => (d === 'new' ? 'old' : 'new'))
  }

  // 切换月重新拉取（用户裁定）：全量口径下月份过滤在前端派生，重拉顺带吸收他端变更
  function shiftMonth(delta) {
    const [y, m] = calMonth.split('-').map(Number)
    setCalMonth(new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7))
    loadNotes()
  }
  function goCalToday() {
    setCalMonth(todayISO().slice(0, 7))
    loadNotes()
  }

  // —— 写操作：成功 → upsertLocal 乐观落 store；失败 → notice ——
  async function patchRow(row, patch, okMsg) {
    try {
      const res = await authorizedFetch(`/api/notes/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ today, ...patch }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `更新失败（${res.status}）`)
      upsertLocal(Array.isArray(body) ? body[0] : body)
      if (okMsg) setNotice(okMsg)
    } catch (err) {
      setNotice(err.message)
    }
  }

  function deleteRow(row) {
    setConfirmDel(null)
    setExpandedId((id) => (id === row.id ? null : id))
    removeLocal(row.id)
    ;(async () => {
      try {
        const res = await authorizedFetch(`/api/notes/${row.id}`, { method: 'DELETE' })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error || `删除失败（${res.status}）`)
        if (body.removed === 0) loadNotes() // 他端已删 → 全量收敛
      } catch (err) {
        setNotice(err.message)
        loadNotes()
      }
    })()
  }

  function openCompose(row = null) {
    if (row) {
      setComposer({ id: row.id, kind: row.kind, content: row.content, due: row.due_date || '' })
    } else {
      setComposer({
        id: null,
        kind: localStorage.getItem(KIND_KEY) === 'idea' ? 'idea' : 'memo',
        content: '',
        due: '',
      })
    }
  }

  async function saveCompose(e) {
    e.preventDefault()
    if (!composer || saving) return
    const content = composer.content.trim()
    if (!content) {
      setNotice('内容不能为空')
      return
    }
    setSaving(true)
    try {
      const isNew = !composer.id
      const payload = isNew
        ? { today, kind: composer.kind, content, due_date: composer.due || null }
        : { today, content, due_date: composer.kind === 'memo' ? composer.due || null : undefined }
      const res = await authorizedFetch(isNew ? '/api/notes' : `/api/notes/${composer.id}`, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `保存失败（${res.status}）`)
      upsertLocal(Array.isArray(body) ? body[0] : body)
      localStorage.setItem(KIND_KEY, composer.kind)
      setComposer(null)
      setNotice(isNew ? '已贴上' : '已更新')
    } catch (err) {
      setNotice(err.message)
    } finally {
      setSaving(false)
    }
  }

  function handleAct(key, row) {
    if (key === 'done' || key === 'finish') {
      // D10：正常期 / 过期期点完成统一写 finished_at（= 用户处理结果，「手动完成」）
      patchRow(row, { finished_at: new Date().toISOString() }, '已完成')
    } else if (key === 'pin') {
      patchRow(row, { pinned: !row.pinned })
    } else if (key === 'edit') {
      openCompose(row)
    } else if (key === 'del') {
      setConfirmDel(row)
    }
  }

  if (!active) return null

  const renderZone = (views, q = '') =>
    views.map((v) => (
      <NoteCard
        key={v.row.id}
        v={v}
        today={today}
        query={q}
        expanded={expandedId === v.row.id}
        onToggle={() => setExpandedId((id) => (id === v.row.id ? null : v.row.id))}
        onAct={handleAct}
      />
    ))

  const zonesEmpty =
    zones.pin.length + zones.timeline.length + zones.expired.length + zones.done.length === 0

  return (
    <div className="nt-panel">
      {(notice || (status === 'error' && message)) && (
        <div className={`bd-notice${!notice && status === 'error' ? ' bd-notice-error' : ''}`}>
          {notice || message}
        </div>
      )}
      {status === 'pending' && <p className="nt-status">加载中…</p>}

      {/* 工具行：类型筛选（纯前端过滤，切换零请求）；段按钮再点一下切换排序 */}
      <div className="nt-toolbar">
        <div className="nt-seg">
          <button type="button" className={kindFilter === 'all' ? 'on' : ''} onClick={() => clickFilter('all')}>
            全部
          </button>
          <button
            type="button"
            className={kindFilter === 'memo' ? 'on' : ''}
            title="备忘各模块按截止日排序（今天到期在前，无日期垫底）——再点一下反向"
            onClick={() => clickFilter('memo')}
          >
            仅备忘{kindFilter === 'memo' ? (memoDir === 'near' ? ' ↑' : ' ↓') : ''}
          </button>
          <button
            type="button"
            className={kindFilter === 'idea' ? 'on' : ''}
            title="灵感各模块按创建时间排序（最新在前）——再点一下反向"
            onClick={() => clickFilter('idea')}
          >
            仅灵感{kindFilter === 'idea' ? (ideaDir === 'new' ? ' ↓' : ' ↑') : ''}
          </button>
        </div>
        <div className="nt-seg nt-seg-right">
          <button type="button" className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>
            列表
          </button>
          <button type="button" className={view === 'cal' ? 'on' : ''} onClick={() => setView('cal')}>
            日历
          </button>
        </div>
      </div>

      {/* 搜索（仅列表视图，PRD 4.6）：固定宽度 = 筛选段无箭头默认态的宽度
          （208px，见 .nt-search 注释），不随激活箭头变宽；日历视图不显示——
          搜索是列表的查找能力，不影响日历落位；查询词切走再切回仍保留 */}
      {view === 'list' && (
        <input
          type="search"
          className="nt-search"
          value={query}
          placeholder="🔍 搜索便利贴内容…"
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      {view === 'cal' ? (
        <div className="nt-cal">
          <div className="nt-cal-bar">
            <button type="button" className="nt-cal-nav" aria-label="上个月" onClick={() => shiftMonth(-1)}>
              ‹
            </button>
            <span className="nt-cal-month">
              {`${calMonth.slice(0, 4)}年${Number(calMonth.slice(5, 7))}月`}
            </span>
            <button type="button" className="nt-cal-nav" aria-label="下个月" onClick={() => shiftMonth(1)}>
              ›
            </button>
            <button type="button" className="nt-cal-now" onClick={goCalToday}>
              今天
            </button>
          </div>
          <div className="nt-cal-week">
            {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
          <div className="nt-cal-grid">
            {calCells.map((day, i) =>
              day == null ? (
                <div key={`blank-${i}`} className="nt-cal-cell nt-cal-blank" />
              ) : (
                <div key={day} className={`nt-cal-cell${day === today ? ' nt-cal-cell-today' : ''}`}>
                  <span className={`nt-cal-day${day === today ? ' nt-cal-day-on' : ''}`}>{Number(day.slice(8))}</span>
                  <div className="nt-cal-items">
                    {(() => {
                      const dayItems = calItems[day] ?? []
                      // >5 条折叠：前 4 条 + 「剩下 +x 个」，点开悬浮列表（2026-09-12 用户裁定）
                      const collapsed = dayItems.length > 5
                      const shown = collapsed ? dayItems.slice(0, 4) : dayItems
                      return (
                        <>
                          {shown.map((row) => (
                            <button
                              key={row.id}
                              type="button"
                              className={`nt-cal-item${row.kind === 'idea' ? ' nt-cal-item-idea' : ''}`}
                              title={row.content.split('\n')[0]}
                              onClick={() => setCalPeek(row)}
                            >
                              {row.pinned ? '📌 ' : ''}
                              {row.kind === 'idea' ? '💡 ' : ''}
                              {row.content.split('\n')[0]}
                            </button>
                          ))}
                          {collapsed && (
                            <button
                              type="button"
                              className="nt-cal-more"
                              onClick={() => setCalDayPeek({ day, rows: dayItems.slice(4) })}
                            >
                              剩下 +{dayItems.length - 4} 个
                            </button>
                          )}
                        </>
                      )
                    })()}
                  </div>
                </div>
              ),
            )}
          </div>
          {Object.keys(calItems).length === 0 && status === 'ok' && (
            <p className="nt-cal-none">本月没有可展示的条目</p>
          )}
        </div>
      ) : searchResults ? (
        <>
          {searchResults.length > 0 ? (
            <>
              <p className="nt-search-count">找到 {searchResults.length} 条含「{query.trim()}」</p>
              <div className="nt-zone">{renderZone(searchResults, query.trim())}</div>
            </>
          ) : (
            status === 'ok' && (
              <div className="nt-empty">
                没有含「{query.trim()}」的便利贴
                <br />
                换个关键词试试
              </div>
            )
          )}
        </>
      ) : (
        <>
      {/* 置顶分区：独立分区默认展开、可手动折叠；到期照常流转不豁免（D11） */}
      {zones.pin.length > 0 && (
        <div className="nt-pinwrap">
          <button type="button" className="nt-foldbar nt-foldbar-pin" onClick={() => toggleFold('pin')}>
            <span className="nt-fold-title">📌 置顶</span>
            <span className="nt-fold-cnt">{zones.pin.length}</span>
            <span className="nt-fold-hint">到期照常流转，不豁免</span>
            <em>{folds.pin ? '收起 ▴' : '展开 ▾'}</em>
          </button>
          {folds.pin && <div className="nt-zone">{renderZone(zones.pin)}</div>}
        </div>
      )}

      {/* 主时间线：创建倒序混排——位置只讲创建时间，紧急程度由角标承担（D12） */}
      {zones.timeline.length > 0 && <div className="nt-zone">{renderZone(zones.timeline)}</div>}

      {zonesEmpty && status === 'ok' && (
        <div className="nt-empty">
          {kindFilter === 'all' ? (
            <>
              还没有便利贴，点右下角 + 记一条
              <br />
              灵感、备忘都行
            </>
          ) : (
            '没有符合条件的条目'
          )}
        </div>
      )}

      {/* 已过期折叠域：按距自动归档升序——最快被收走的排最前（D8） */}
      {zones.expired.length > 0 && (
        <>
          <button type="button" className="nt-foldbar" onClick={() => toggleFold('expired')}>
            <span className="nt-fold-title">已过期</span>
            <span className="nt-fold-cnt">{zones.expired.length}</span>
            <span className="nt-fold-hint">快被收走的排最前</span>
            <em>{folds.expired ? '收起 ▴' : '展开 ▾'}</em>
          </button>
          {folds.expired && <div className="nt-zone">{renderZone(zones.expired)}</div>}
        </>
      )}

      {/* 已完成折叠域：默认收起；两种来源标识；30 天静默清除（D10） */}
      {zones.done.length > 0 && (
        <>
          <button type="button" className="nt-foldbar" onClick={() => toggleFold('done')}>
            <span className="nt-fold-title">已完成</span>
            <span className="nt-fold-cnt">{zones.done.length}</span>
            <span className="nt-fold-hint">30 天后自动清除</span>
            <em>{folds.done ? '收起 ▴' : '展开 ▾'}</em>
          </button>
          {folds.done && <div className="nt-zone">{renderZone(zones.done)}</div>}
        </>
      )}
        </>
      )}

      <div className="bd-fab-wrap">
        <button type="button" className="bd-fab-btn" aria-label="记一条" onClick={() => openCompose()}>
          +
        </button>
      </div>

      {/* 新建 / 编辑弹窗：类型二选一（编辑态锁定，D15）；日期可选、只到今天+7、
          没有「几点」——记录零决策成本（7.1） */}
      {composer && (
        <div className="bd-modal-backdrop" onClick={() => !saving && setComposer(null)}>
          <form className="bd-modal-card nt-compose" onSubmit={saveCompose} onClick={(e) => e.stopPropagation()}>
            <div className="bd-modal-head">
              <h3 className="bd-modal-title">{composer.id ? '修改' : '记一条'}</h3>
            </div>
            <div className="bd-modal-scroll">
              {composer.id ? (
                <div className="nt-kindlock">
                  {KIND_LABELS[composer.kind]}
                  <span>类型创建后不可更改，记错了删掉重记</span>
                </div>
              ) : (
                <div className="nt-typeseg">
                  <button
                    type="button"
                    className={composer.kind === 'memo' ? 'on' : ''}
                    onClick={() => setComposer({ ...composer, kind: 'memo' })}
                  >
                    备忘
                  </button>
                  <button
                    type="button"
                    className={composer.kind === 'idea' ? 'on' : ''}
                    onClick={() => setComposer({ ...composer, kind: 'idea', due: '' })}
                  >
                    灵感
                  </button>
                </div>
              )}
              <textarea
                className="nt-textarea"
                value={composer.content}
                rows={4}
                maxLength={CONTENT_MAX}
                placeholder={composer.kind === 'memo' ? '怕忘的事，一句话就行' : '想到什么写什么'}
                onChange={(e) => setComposer({ ...composer, content: e.target.value })}
              />
              <div className="nt-counter">
                {composer.content.length} / {CONTENT_MAX}
              </div>
              {composer.kind === 'memo' && (
                <div className="nt-due">
                  <div className="nt-sublabel">日期（可选）</div>
                  <div className="nt-dueseg">
                    <button
                      type="button"
                      className={!composer.due ? 'on' : ''}
                      onClick={() => setComposer({ ...composer, due: '' })}
                    >
                      不设日期
                    </button>
                    <button
                      type="button"
                      className={composer.due ? 'on' : ''}
                      onClick={() => setComposer({ ...composer, due: composer.due || today })}
                    >
                      指定日期
                    </button>
                  </div>
                  {composer.due && (
                    <input
                      type="date"
                      className="nt-date"
                      value={composer.due}
                      min={today}
                      max={addDaysISO(today, DUE_MAX_LOOKAHEAD_DAYS)}
                      onChange={(e) => setComposer({ ...composer, due: e.target.value })}
                    />
                  )}
                  <p className="nt-duehint">
                    最早今天 · 最晚 {shortDate(addDaysISO(today, DUE_MAX_LOOKAHEAD_DAYS))} ·
                    按「天」记，没有「几点」
                    <br />
                    不设日期：7 天后自动进入已过期，再 7 天自动归档，全程无提醒
                  </p>
                </div>
              )}
            </div>
            <div className="bd-modal-foot">
              <div className="bd-modal-actions">
                <button type="button" className="bd-btn bd-btn-ghost" onClick={() => setComposer(null)}>
                  取消
                </button>
                <button type="submit" className="bd-btn" disabled={saving}>
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* 删除确认：唯一不可逆动作（任意状态可删） */}
      {confirmDel && (
        <div className="bd-modal-backdrop" onClick={() => setConfirmDel(null)}>
          <div className="bd-modal-card nt-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="bd-modal-head">
              <h3 className="bd-modal-title">删除这条{KIND_LABELS[confirmDel.kind]}？</h3>
            </div>
            <div className="bd-modal-scroll">
              <p className="nt-confirm-text">「{confirmDel.content.split('\n')[0]}」将永久删除，不可恢复。</p>
            </div>
            <div className="bd-modal-foot">
              <div className="bd-modal-actions">
                <button type="button" className="bd-btn bd-btn-ghost" onClick={() => setConfirmDel(null)}>
                  取消
                </button>
                <button type="button" className="bd-btn bd-btn-danger" onClick={() => deleteRow(confirmDel)}>
                  删除
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 日历格折叠剩余条目的悬浮列表（>5 条时出现，2026-09-12 用户裁定） */}
      {calDayPeek && (
        <div className="bd-modal-backdrop" onClick={() => setCalDayPeek(null)}>
          <div className="bd-modal-card nt-peek-list" onClick={(e) => e.stopPropagation()}>
            <div className="bd-modal-head">
              <h3 className="bd-modal-title">
                {shortDate(calDayPeek.day)} · 剩下 {calDayPeek.rows.length} 条
              </h3>
            </div>
            <div className="bd-modal-scroll">
              <div className="nt-peek-rows">
                {calDayPeek.rows.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className="nt-peek-row"
                    onClick={() => {
                      setCalDayPeek(null)
                      setCalPeek(row)
                    }}
                  >
                    <span className="nt-peek-row-kind">
                      {row.kind === 'idea' ? '💡' : row.pinned ? '📌' : '📝'}
                    </span>
                    <span className="nt-peek-row-text">{row.content.split('\n')[0]}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="bd-modal-foot">
              <div className="bd-modal-actions">
                <button type="button" className="bd-btn bd-btn-ghost" onClick={() => setCalDayPeek(null)}>
                  关闭
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 日历条目只读弹层：仅展示，不具备删除和修改（2026-09-12 用户裁定，参考会员页详情） */}
      {calPeek && <CalPeekModal row={calPeek} today={today} onClose={() => setCalPeek(null)} />}
    </div>
  )
}

// ---------- 卡片（状态 × 类型 → 样式与动作，对照样式稿 notes-v3-mockup.html） ----------

function NoteCard({ v, today, expanded, onToggle, onAct, query = '' }) {
  const { row, state } = v
  const isIdea = row.kind === 'idea'
  const done = state === 'done-manual' || state === 'done-auto'
  const chip = countdownOf(row, today)
  const lines = row.content.split('\n')
  const rest = lines.slice(1).join('\n')

  const cls = [
    'nt-note',
    done
      ? 'nt-gone nt-done'
      : state === 'expired'
        ? 'nt-gone'
        : isIdea
          ? 'nt-idea'
          : chip?.key === 'today'
            ? 'nt-memo nt-due'
            : 'nt-memo',
    expanded ? 'nt-open' : '',
  ]
    .filter(Boolean)
    .join(' ')

  // 角标 / 标识：倒计时（正常备忘）→ 已过期 N 天 → 完成来源标识
  let badge = null
  if (state === 'expired') {
    badge = <span className="nt-chip nt-chip-exp">已过期 {expiredDays(row, today)} 天</span>
  } else if (chip) {
    badge = <span className={`nt-chip nt-chip-${chip.key}`}>{chip.text}</span>
  } else if (done) {
    badge = (
      <span className={`nt-tag ${state === 'done-manual' ? 'nt-tag-manual' : 'nt-tag-auto'}`}>
        {state === 'done-manual' ? '手动完成' : '超期自动归档'}
      </span>
    )
  }

  // meta：相对时间；已过期显截止日；无日期备忘弱化小字「未设日期」（D5）
  let meta
  if (state === 'expired') {
    meta = <span className="nt-ago">截止 {shortDate(deadlineOf(row))}</span>
  } else if (state === 'done-manual') {
    meta = <span className="nt-ago">{agoText(row.finished_at)}完成</span>
  } else if (state === 'done-auto') {
    meta = <span className="nt-ago">{shortDate(archiveDayOf(row))}归档</span>
  } else if (!isIdea && !row.due_date) {
    meta = (
      <>
        <span className="nt-nodate">未设日期</span>
        <span className="nt-ago">{agoText(row.created_at)}</span>
      </>
    )
  } else {
    meta = <span className="nt-ago">{agoText(row.created_at)}</span>
  }

  // 动作矩阵（PRD 5.2）：完成只在备忘上；灵感没有「完成」；过期仅转已完成 + 删除；
  // 已完成仅删除（不可恢复 / 不可编辑）
  const acts = []
  if (state === 'normal' && !isIdea) {
    acts.push({ key: 'done', label: '标记完成', icon: iconCheck, pri: true })
  }
  if (state === 'expired') {
    acts.push({ key: 'done', label: '转为已完成', icon: iconCheck, pri: true })
  }
  if (state === 'normal') {
    acts.push({ key: 'pin', label: row.pinned ? 'UnPin' : 'Pin', icon: row.pinned ? iconPinOff : iconPin })
  }
  if (state === 'normal') acts.push({ key: 'edit', label: '修改', icon: iconEditor })
  acts.push({ key: 'del', label: '删除', icon: iconDelete, del: true })

  // 完成动作独占一行（2026-09-12 用户裁定），其余按钮一行
  const actDone = acts.find((a) => a.key === 'done')
  const actRest = acts.filter((a) => a.key !== 'done')
  const renderAct = (a) => (
    <span
      key={a.key}
      className={`${a.pri ? 'pri' : ''}${a.del ? ' del' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onAct(a.key, row)
      }}
    >
      <img className="bd-action-icon nt-act-ico" src={a.icon} alt="" aria-hidden="true" />
      {a.label}
    </span>
  )

  return (
    <div
      className={cls}
      style={{ '--nt-tilt': `${hashTilt(row.id)}deg` }}
      onClick={onToggle}
    >
      <div className="nt-head">
        {isIdea && <span className="nt-idea-badge">💡</span>}
        <span className="nt-title">
          <Highlight text={lines[0]} query={query} />
        </span>
        {badge}
      </div>
      {rest && (
        <div className={`nt-body${expanded ? '' : ' nt-clamp'}`}>
          <Highlight text={rest} query={query} />
        </div>
      )}
      <div className="nt-meta">{meta}</div>
      {expanded && (
        <>
          {actDone && <div className="nt-acts">{renderAct(actDone)}</div>}
          <div className="nt-acts">{actRest.map((a) => renderAct(a))}</div>
        </>
      )}
    </div>
  )
}

// ---------- 命中高亮（搜索态专用；切分口径同 shared/notesDomain.js splitHighlight） ----------

function Highlight({ text, query }) {
  if (!query) return text
  return splitHighlight(text, query).map((seg, i) =>
    seg.hit ? (
      <mark key={i} className="nt-mark">
        {seg.text}
      </mark>
    ) : (
      seg.text
    ),
  )
}

// ---------- 日历只读弹层（2026-09-12 用户裁定：点击条目仅展示，不具备删除和修改） ----------

function CalPeekModal({ row, today, onClose }) {
  const state = deriveState(row, today)
  const chip = countdownOf(row, today)
  let badge = null
  if (state === 'expired') {
    badge = <span className="nt-chip nt-chip-exp">已过期 {expiredDays(row, today)} 天</span>
  } else if (chip) {
    badge = <span className={`nt-chip nt-chip-${chip.key}`}>{chip.text}</span>
  } else if (state === 'done-manual') {
    badge = <span className="nt-tag nt-tag-manual">手动完成</span>
  } else if (state === 'done-auto') {
    badge = <span className="nt-tag nt-tag-auto">超期自动归档</span>
  }
  let meta
  if (state === 'expired') meta = `截止 ${shortDate(deadlineOf(row))}`
  else if (state === 'done-manual') meta = `${agoText(row.finished_at)}完成`
  else if (state === 'done-auto') meta = `${shortDate(archiveDayOf(row))}归档`
  else if (row.kind === 'memo' && !row.due_date) meta = `未设日期 · 记录于 ${agoText(row.created_at)}`
  else meta = `记录于 ${agoText(row.created_at)}`
  return (
    <div className="bd-modal-backdrop" onClick={onClose}>
      <div className="bd-modal-card nt-peek" onClick={(e) => e.stopPropagation()}>
        <div className="bd-modal-head">
          <h3 className="bd-modal-title">
            {row.kind === 'idea' ? '灵感' : '备忘'}
            {row.pinned ? ' · 📌 已置顶' : ''}
          </h3>
        </div>
        <div className="bd-modal-scroll">
          <div className="nt-peek-body">{row.content}</div>
          <div className="nt-peek-meta">
            {badge}
            <span className="nt-peek-meta-text">{meta}</span>
          </div>
          <p className="nt-peek-hint">只读预览——修改请回列表展开卡片操作</p>
        </div>
        <div className="bd-modal-foot">
          <div className="bd-modal-actions">
            <button type="button" className="bd-btn bd-btn-ghost" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

