// 便利贴导出的表构建：全量行 → 一张 Excel 表（纯函数，无 DOM，可在 node 里断言）。
//
// 口径一律复用 shared/notesDomain.js，不在这层另立定义：
//   · 行范围 = 未清除行（isCleared 为真的物理行页面上也不显示，导出同样不给出）；
//   · 状态   = deriveState + expiredDays，文案与面板徽标逐字一致；
//   · 排序   = sortCreatedDesc（创建时间倒序，与主时间线同一支序，同刻按 id 定序）。
// 「截止日期」列：用户设过的直接给日期；未设日期的备忘写「推算 YYYY-MM-DD」——
// 页面对这两种情况分别显示日期和「未设日期」，导出成一列时必须把来源标出来，
// 否则用户会把自己没设过的兜底截止（创建日 + 7）读成自己写的期限（D5 同一顾虑）。
// 灵感无日期概念（D3），该列留空。

import {
  deadlineOf,
  deriveState,
  expiredDays,
  isCleared,
  sortCreatedDesc,
} from '../../shared/notesDomain.js'

const KIND_LABELS = { memo: '备忘', idea: '灵感' }

const STATE_LABELS = {
  normal: '正常',
  'done-manual': '手动完成',
  'done-auto': '超期自动归档',
}

export const EXPORT_HEADERS = [
  '类型',
  '内容',
  '状态',
  '截止日期(未设日期为系统推算)',
  '是否置顶',
  '创建时间',
  '完成时间',
]

// 列宽按内容列最占版面来给；内容上限 500 字（CONTENT_MAX），超宽部分由 Excel 裁切
export const EXPORT_WIDTHS = [8, 60, 18, 26, 10, 18, 18]

const pad = (n) => String(n).padStart(2, '0')

// timestamptz → 查看设备本地日历的 'YYYY-MM-DD HH:mm'（与 todayISO 同一时区口径）
function formatLocal(timestamp) {
  if (!timestamp) return ''
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function stateLabel(row, today) {
  const state = deriveState(row, today)
  if (state === 'expired') return `已过期 ${expiredDays(row, today)} 天`
  return STATE_LABELS[state]
}

function dueCell(row) {
  if (row.kind === 'idea') return ''
  return row.due_date || `推算 ${deadlineOf(row)}`
}

// rows = GET /api/notes 的原始行；today 按查看设备本地日历；nowMs 供手动完成行的
// 精确清除判定（同 notesStore.loadNotes 的调用口径）
export function buildNotesExport(rows, today, nowMs = Date.now()) {
  const list = Array.isArray(rows) ? rows : []
  const kept = list.filter((row) => !isCleared(row, today, nowMs))
  const sorted = sortCreatedDesc(kept.map((row) => ({ row, state: deriveState(row, today) })))

  return {
    exported: sorted.length,
    cleared: list.length - kept.length,
    sheet: {
      name: '便利贴',
      header: EXPORT_HEADERS,
      widths: EXPORT_WIDTHS,
      rows: sorted.map(({ row }) => [
        KIND_LABELS[row.kind] || row.kind,
        row.content,
        stateLabel(row, today),
        dueCell(row, today),
        row.pinned ? '是' : '否',
        formatLocal(row.created_at),
        formatLocal(row.finished_at),
      ]),
    },
  }
}

export function exportFileName(today) {
  return `便利贴导出-${today}.xlsx`
}
