import { useMemo, useState } from 'react'
import { addDaysISO, colorForCard, diffDays } from '../lib/cardsDomain'
import { BILLING_CYCLES } from '../../shared/cardsConfig'

// ============================================================
// 会员页 · 日历展示模式（2026-09-03 与用户共同设计；同日六条修订）：
// 飞书日程风格的月视图——每张卡一条 起始日 → 终止日 的跨天日程条，
// 跨周折行、跨月断口画延续箭头；今天用品牌蓝胶囊 + 列底色标注。
// 修订规则：
//   · 日程条文字（卡名）只在**本月首次出现的头部段**显示，换周只画色条；
//     跨月后在新月头部重新显示（6）
//   · 今日之前的段整段置灰（5）
//   · 点日程条 → 只读详情弹窗（不允许修改，2）
//   · 卡片筛选：选中集语义、最多 5 张、面板内按卡名关键词搜索（3/4）
// 数据 = 进站快照（cardsStore），零额外请求。
// ============================================================

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']
const MAX_SELECTED = 5

function dowMondayFirst(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

// 月视图网格：从当月 1 日所在周的周一铺到月末所在周的周日（5 或 6 行）
function buildWeeks(ym) {
  const [y, m] = ym.split('-').map(Number)
  const first = `${ym}-01`
  const gridStart = addDaysISO(first, -dowMondayFirst(first))
  const last = addDaysISO(first, new Date(Date.UTC(y, m, 0)).getUTCDate() - 1)
  const gridEnd = addDaysISO(last, 6 - dowMondayFirst(last))
  const weeks = []
  for (let ws = gridStart; ws <= gridEnd; ws = addDaysISO(ws, 7)) {
    const days = Array.from({ length: 7 }, (_, i) => {
      const iso = addDaysISO(ws, i)
      return { iso, day: Number(iso.slice(8)), inMonth: iso.slice(0, 7) === ym }
    })
    weeks.push({ start: ws, end: addDaysISO(ws, 6), days })
  }
  return weeks
}

// 周内车道分配（first-fit）：按原始起始日排序（同周内跨周长卡车道稳定，不因
// 裁剪起点变化而上下跳动），同起始日按原始终止日；依次放入互不重叠的车道
function layoutWeek(week, events) {
  const clipped = events
    .map((e) => ({ ...e, cs: e.start < week.start ? week.start : e.start, ce: e.end > week.end ? week.end : e.end }))
    .filter((e) => e.cs <= e.ce)
    .sort((a, b) =>
      a.start === b.start ? (a.end === b.end ? 0 : a.end < b.end ? -1 : 1) : a.start < b.start ? -1 : 1
    )
  const lanes = []
  for (const ev of clipped) {
    let lane = lanes.find((l) => l.every((o) => ev.cs > o.ce))
    if (!lane) {
      lane = []
      lanes.push(lane)
    }
    lane.push(ev)
  }
  return lanes
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`
}

function CalBar({ ev, week, today, showText, onOpenCard }) {
  const { view, cs, ce, lane } = ev
  const row = view.row
  const expired = view.status === 'expired'
  const colStart = diffDays(week.start, cs)
  const colEnd = diffDays(week.start, ce)
  const color = colorForCard(row.id)
  // 今日之前的日程置灰（修订 5）：不拆段——单条日程条上用硬分界渐变实现双色，
  // 分界线精确落在"今天"列的边界（7 列等宽，比例 = 今天前的段内天数 / 段总天数）
  const todayCol = diffDays(week.start, today)
  const wholePast = ce < today
  const frac =
    !wholePast && today >= cs && today <= ce
      ? (Math.min(todayCol, colEnd) - colStart) / (colEnd - colStart + 1)
      : 0
  const background =
    frac > 0
      ? `linear-gradient(90deg, #e6e9ec 0 ${(frac * 100).toFixed(4)}%, ${color} ${(frac * 100).toFixed(4)}% 100%)`
      : color
  const clippedLeft = row.start_date < week.start
  const clippedRight = row.end_date > week.end
  return (
    <button
      type="button"
      className={`cd-cal-bar${expired ? ' cd-cal-bar-expired' : ''}${wholePast ? ' cd-cal-bar-past' : ''}`}
      style={{ background, gridColumn: `${colStart + 1} / ${colEnd + 2}`, gridRow: lane + 1 }}
      title={`${row.name} · ${row.start_date} ~ ${row.end_date}${expired ? ' · 已过期' : ''}`}
      onClick={() => onOpenCard(view)}
    >
      {clippedLeft && <span className="cd-cal-bar-clip">‹ </span>}
      {showText && <span className="cd-cal-bar-name">{row.name}</span>}
      {clippedRight && <span className="cd-cal-bar-clip"> ›</span>}
    </button>
  )
}

// 卡片多选筛选（选中集语义，最多 5 张，支持卡名关键词搜索）——3/4
function FilterDropdown({ views, selectedIds, onToggle, onSetAll }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const atCap = selectedIds.size >= MAX_SELECTED
  const kw = query.trim().toLowerCase()
  const shown = kw ? views.filter((v) => v.row.name.toLowerCase().includes(kw)) : views
  return (
    <div className="cd-cal-filter">
      <button type="button" className="bd-sort-btn" onClick={() => setOpen((v) => !v)}>
        卡片筛选 {selectedIds.size}/{views.length} ▾
      </button>
      {open && (
        <>
          <div className="cd-cal-filter-backdrop" onClick={() => setOpen(false)} />
          <div className="cd-cal-filter-panel">
            <input
              className="cd-cal-filter-search"
              type="text"
              placeholder="搜索卡名"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="cd-cal-filter-ops">
              <button
                type="button"
                className="bd-sort-btn bd-sort-btn-active"
                disabled={views.length > MAX_SELECTED}
                onClick={() => onSetAll(true)}
              >
                全选{views.length > MAX_SELECTED ? `（超过 ${MAX_SELECTED} 张）` : ''}
              </button>
              <button type="button" className="bd-sort-btn" onClick={() => onSetAll(false)}>
                清空
              </button>
            </div>
            {shown.length === 0 && <p className="cd-cal-filter-empty">没有匹配的卡</p>}
            {shown.map((v) => {
              const checked = selectedIds.has(v.row.id)
              return (
                <label key={v.row.id} className={`cd-cal-filter-item${!checked && atCap ? ' cd-cal-filter-capped' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && atCap}
                    onChange={() => onToggle(v.row.id)}
                  />
                  <span className="cd-cal-filter-dot" style={{ background: colorForCard(v.row.id) }} />
                  <span className="cd-cal-filter-name">{v.row.name}</span>
                  {v.status === 'expired' && <span className="cd-tag">已过期</span>}
                  {v.sunkReason === 'used_up' && <span className="cd-tag">已用完</span>}
                </label>
              )
            })}
            {atCap && <p className="cd-cal-filter-cap">最多同时展示 {MAX_SELECTED} 张卡</p>}
          </div>
        </>
      )}
    </div>
  )
}

// 日历模式详情弹窗内容（2：只展示、不允许修改——全字段修改走列表模式的详情态）
export function CardReadonlyDetail({ view, today }) {
  const { row } = view
  const daysLeft = diffDays(today, row.end_date)
  const expired = view.status === 'expired'
  const cycleLabel = Object.fromEntries(BILLING_CYCLES.map((c) => [c.key, c.label]))
  const renew = !row.auto_renew
    ? '关'
    : `开 · ${row.billing_cycle ? cycleLabel[row.billing_cycle] || row.billing_cycle : `每 ${row.period_days} 天`}${
        row.next_billing_date ? ` · ${row.next_billing_date} 扣款` : ''
      }`
  const sessions =
    row.remaining_sessions == null
      ? '未开启'
      : `剩 ${row.remaining_sessions}${row.total_sessions != null ? ` / ${row.total_sessions}` : ''} 次`
  const muted = row.muted === 'cycle' ? '本期静默' : row.muted === 'forever' ? '永久静默' : '无'
  const rows = [
    ['状态', expired ? '已过期' : '进行中'],
    ['有效期', `${row.start_date} ~ ${row.end_date}（${expired ? `已过期 ${-daysLeft} 天` : `剩 ${daysLeft} 天`}）`],
    ['次数', sessions],
    ['自动续费', renew],
    ['静默', muted],
  ]
  return (
    <div className="cd-ro">
      <p className="cd-ro-title">{row.name}</p>
      {rows.map(([label, value]) => (
        <p key={label} className="cd-ro-row">
          <span className="cd-ro-label">{label}</span>
          <span className="cd-ro-value">{value}</span>
        </p>
      ))}
    </div>
  )
}

export default function CardsCalendar({
  views,
  today,
  selectedIds,
  onToggleCard,
  onSetAll,
  onOpenCard,
  modeSeg,
}) {
  const [ym, setYm] = useState(() => today.slice(0, 7))
  const isCurrentMonth = ym === today.slice(0, 7)

  const weeks = useMemo(() => buildWeeks(ym), [ym])
  const shownEvents = useMemo(() => views.filter((v) => selectedIds.has(v.row.id)), [views, selectedIds])
  // 每周布局 + 头部段标记：卡名只画在本月首次出现的那一周（6）
  const laidOut = useMemo(() => {
    const events = shownEvents.map((v) => ({ view: v, start: v.row.start_date, end: v.row.end_date }))
    const headWeek = new Map()
    const result = weeks.map((week, wi) => {
      const lanes = layoutWeek(week, events)
      for (const lane of lanes) {
        for (const ev of lane) {
          if (!headWeek.has(ev.view.row.id)) headWeek.set(ev.view.row.id, wi)
        }
      }
      return { week, lanes }
    })
    return { result, headWeek }
  }, [weeks, shownEvents])
  const monthLabel = `${Number(ym.slice(0, 4))}年${Number(ym.slice(5, 7))}月`

  return (
    <div className="cd-cal">
      <div className="cd-cal-toolbar">
        <div className="cd-cal-nav">
          <button type="button" className="bd-sort-btn" onClick={() => setYm(shiftMonth(ym, -1))} aria-label="上个月">
            ‹
          </button>
          <span className="cd-cal-month">{monthLabel}</span>
          <button type="button" className="bd-sort-btn" onClick={() => setYm(shiftMonth(ym, 1))} aria-label="下个月">
            ›
          </button>
          <button
            type="button"
            className={`bd-sort-btn ${isCurrentMonth ? 'bd-sort-btn-active' : ''}`}
            disabled={isCurrentMonth}
            onClick={() => setYm(today.slice(0, 7))}
          >
            今天
          </button>
        </div>
        <div className="cd-cal-tools">
          <FilterDropdown
            views={views}
            selectedIds={selectedIds}
            onToggle={onToggleCard}
            onSetAll={onSetAll}
          />
          {modeSeg}
        </div>
      </div>

      {views.length === 0 ? (
        <div className="bd-notice">还没有卡数据。点右下角「+」增加一条，或去批量增加页提交一批。</div>
      ) : shownEvents.length === 0 ? (
        <div className="bd-notice">
          日历为空：在右上方「卡片筛选」中勾选要展示的卡（最多 {MAX_SELECTED} 张）。
        </div>
      ) : (
        <div className="cd-cal-grid">
          <div className="cd-cal-weekdays">
            {WEEKDAY_LABELS.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
          {laidOut.result.map(({ week, lanes }, wi) => (
            <div key={week.start} className="cd-cal-week" style={{ '--lanes': Math.max(lanes.length, 1) }}>
              <div className="cd-cal-bgcols">
                {week.days.map((d) => (
                  <span key={d.iso} className={d.iso === today ? 'cd-cal-today-col' : ''} />
                ))}
              </div>
              <div className="cd-cal-nums">
                {week.days.map((d) => (
                  <span
                    key={d.iso}
                    className={`cd-cal-num${d.inMonth ? '' : ' cd-cal-num-out'}${d.iso === today ? ' cd-cal-today' : ''}`}
                  >
                    <i>{d.day}</i>
                  </span>
                ))}
              </div>
              <div className="cd-cal-bars">
                {lanes.map((lane, li) =>
                  lane.map((ev) => (
                    <CalBar
                      key={ev.view.row.id}
                      ev={{ ...ev, lane: li }}
                      week={week}
                      today={today}
                      showText={laidOut.headWeek.get(ev.view.row.id) === wi}
                      onOpenCard={onOpenCard}
                    />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
