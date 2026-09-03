import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import { applyRows, useCardsStore } from '../lib/cardsStore'
import * as api from '../lib/apiClient'
import {
  buildImportPayload,
  classifyImport,
  formatFieldValue,
  mergeImportRows,
  parseCardsText,
  todayISO,
} from '../lib/cardsDomain'
import './board.css'
import { BILLING_CYCLES, DDL_MAX_HORIZON_YEARS } from '../../shared/cardsConfig.js'

// ============================================================
// 会员批量导入页（PRD 5.6 / S2 / S15）：骨架复用 BalanceImport——
// hero 说明 → 大 textarea → 解析预览 → 全宽提交 → 结果 notice。
// 预览分三组：新增（默认值标注）/ 更新（旧→新全量对照 + 过期行去向，唯一人工关卡）/
// 错误（逐行报错）。发现不对 → 回文本框改原文重新解析；提交即落库，无逐条确认。
// 快照来自进站时已加载的模块级 store（预览分类 0 请求，cards-db.md 1.2）。
// ============================================================

const ACTION_LABEL = {
  update: '覆盖更新',
  update_to_expired: '将更新为过期',
  skip_expired: '跳过（库内已过期）',
}

const CYCLE_LABEL = Object.fromEntries(BILLING_CYCLES.map((c) => [c.key, c.label]))

function renewText(row) {
  if (!row.auto_renew) return '关'
  const cycle = row.billing_cycle
    ? CYCLE_LABEL[row.billing_cycle] || row.billing_cycle
    : row.period_days != null
      ? `每 ${row.period_days} 天`
      : '周期缺失'
  return `开 · ${cycle}${row.next_billing_date ? ` · ${row.next_billing_date} 扣款` : ''}`
}

const PLACEHOLDER = [
  '卡名,起始日,终止日,剩余次数,每周期次数,自动续费,扣款周期,合同天数,扣款日',
  'Tony-理发季卡,2026-08-31,2026-11-29,30',
  '爱奇艺-月会员,,2026-09-14,,,是,月,,2026-09-14',
  '超鹿-30次卡,,,8,30',
].join('\n')

function Tag({ children, tone }) {
  return <span className={`cd-tag ${tone ? `cd-tag-${tone}` : ''}`}>{children}</span>
}

export default function CardsImport() {
  const { logout } = useAuth()
  const store = useCardsStore()
  const [rawText, setRawText] = useState('')
  const [submitState, setSubmitState] = useState({ status: 'idle', message: '' })

  // 快照由 App 级进站会话负责加载（cardsStore.initCardsSession）：直链进入本页
  // 同样会触发；此处不再自行 loadCards——路由跳转不是进站（3.3.3）

  const parsed = useMemo(() => parseCardsText(rawText), [rawText])
  const merged = useMemo(() => mergeImportRows(parsed.rows), [parsed.rows])
  const classification = useMemo(
    () =>
      rawText.trim().length > 0
        ? classifyImport(merged, store.rows, todayISO())
        : { creates: [], updates: [], errors: [] },
    [merged, store.rows, rawText]
  )

  // 统一按行号排序展示（数组 sort 为稳定排序：同行内解析错误仍排在分类错误前）
  const allErrors = [...parsed.errors, ...classification.errors].sort((a, b) => a.line - b.line)
  const validCount = classification.creates.length + classification.updates.length
  const updateCount = classification.updates.filter((u) => u.action !== 'skip_expired').length
  const skipCount = classification.updates.filter((u) => u.action === 'skip_expired').length

  const canSubmit =
    validCount > 0 && allErrors.length === 0 && store.status === 'ok' && submitState.status !== 'submitting'

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitState({ status: 'submitting', message: '' })
    const payload = buildImportPayload(classification)

    try {
      const res = await api.authorizedFetch('/api/cards/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // today = 客户端本地日期（预留 #8 窗口口径）
        body: JSON.stringify({ rows: payload, today: todayISO() }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `提交失败（${res.status}）`)

      applyRows(Array.isArray(body) ? body : store.rows)
      setSubmitState({
        status: 'ok',
        message: `已提交：新增 ${classification.creates.length} / 更新 ${updateCount}${
          skipCount > 0 ? ` / 跳过 ${skipCount}` : ''
        }。提醒将在下次进站时按新数据统一计算。`,
      })
      setRawText('')
    } catch (err) {
      setSubmitState({ status: 'error', message: err.message })
    }
  }

  return (
    <div className="bd-import">
      <header className="bd-import-header">
        <div className="bd-import-top">
          <div>
            <p className="bd-eyebrow">Cards Import</p>
            <h1 className="bd-title">会员卡批量导入</h1>
          </div>
          <div className="bd-header-actions">
            <Link className="bd-text-btn" to="/app">
              返回管理端
            </Link>
            <button className="bd-text-btn" onClick={logout}>
              退出登录
            </button>
          </div>
        </div>
        <p className="bd-import-hint">
          把外部工具的扫描结果整表复制粘贴到下方（首行可以是列名，支持 Tab / 逗号 / 空格分隔）。
          同名卡逐字段取最后值；已有卡只更新行内携带的字段、缺失保留现值；新卡缺失字段取默认（终止日期
          → 今天 + {DDL_MAX_HORIZON_YEARS} 年）。提交前请在「更新」预览里核对每一处 旧 → 新。
        </p>
      </header>

      <div className="bd-import-body">
        <textarea
          className="bd-textarea"
          placeholder={PLACEHOLDER}
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          rows={10}
        />

        {store.status === 'pending' && store.rows.length === 0 && (
          <div className="bd-status-line">
            <span className="bd-dot bd-dot-pending" />
                正在加载会员卡快照…
          </div>
        )}
        {store.status === 'error' && (
          <div className="bd-notice bd-notice-error">加载会员卡失败：{store.message}</div>
        )}
        {store.status === 'ok' && rawText.trim().length > 0 && store.rows.length === 0 && (
          <p className="cd-empty-note">当前库内没有卡：所有有效行都将作为新增写入。</p>
        )}

        {rawText.trim().length > 0 && (
          <div className="bd-preview">
            {/* ① 新增 */}
            {classification.creates.length > 0 && (
              <div className="cd-preview-group">
                <p className="bd-preview-title">新增 {classification.creates.length} 条</p>
                <table className="bd-table">
                  <thead>
                    <tr>
                      <th>卡名</th>
                      <th>有效期</th>
                      <th>次数</th>
                      <th>续费</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {classification.creates.map((c) => (
                      <tr key={`c${c.line}`}>
                        <td>{c.row.name}</td>
                        <td>
                          {c.row.end_date || `→ 今天+${DDL_MAX_HORIZON_YEARS}年`}
                          {c.row.start_date ? `（${c.row.start_date} 起）` : ''}
                        </td>
                        <td>
                          {c.row.remaining_sessions != null
                            ? `${c.row.remaining_sessions}${c.row.total_sessions != null ? ` / ${c.row.total_sessions}` : ''} 次`
                            : '—'}
                        </td>
                        <td>{renewText(c.row)}</td>
                        <td>
                          {c.action === 'insert_expired' && <Tag tone="warn">新增过期记录</Tag>}
                          {c.defaults.map((d) => (
                            <Tag key={d.label} tone="plain">
                              {d.label} 默认
                            </Tag>
                          ))}
                          {c.sessionsOn && <Tag tone="plain">次数能力开启</Tag>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* ② 更新：旧 → 新全量对照（默认展开，唯一人工核对关卡） */}
            {classification.updates.length > 0 && (
              <div className="cd-preview-group">
                <p className="bd-preview-title">
                  更新 {updateCount} 条{skipCount > 0 ? ` · 跳过 ${skipCount} 条` : ''} · 请核对 旧 → 新
                </p>
                {classification.updates.map((u) => (
                  <div key={`u${u.line}`} className="cd-update-card">
                    <p className="cd-update-name">
                      {u.row.name}
                      {u.action !== 'update' && (
                        <Tag tone={u.action === 'skip_expired' ? 'plain' : 'warn'}>{ACTION_LABEL[u.action]}</Tag>
                      )}
                      {u.ignoredSessions && <Tag tone="plain">次数字段已忽略（能力未开启）</Tag>}
                      {u.ignoredBilling && <Tag tone="plain">扣款字段已忽略（未开续费）</Tag>}
                    </p>
                    {u.diff.length > 0 ? (
                      <div className="cd-diff">
                        {u.diff.map((d) => (
                          <p className="cd-diff-row" key={d.field}>
                            <span className="cd-diff-field">{d.label}</span>
                            <span className="cd-diff-old">{formatFieldValue(d.field, d.old)}</span>
                            <span className="cd-diff-arrow">→</span>
                            <span className="cd-diff-new">{formatFieldValue(d.field, d.new)}</span>
                          </p>
                        ))}
                      </div>
                    ) : (
                      <p className="cd-empty-note">与库内当前状态一致，无字段变化</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* ③ 错误：逐行报错（沿用余额导入样式） */}
            {allErrors.length > 0 && (
              <div className="cd-preview-group">
                <p className="bd-preview-title">错误 {allErrors.length} 行 · 修正后才能提交</p>
                <div className="bd-errors">
                  {allErrors.map((e, i) => (
                    <p key={i} className="bd-error-line">
                      第 {e.line} 行：{e.reason}
                      {e.raw ? ` —「${e.raw}」` : ''}
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <button type="button" className="bd-btn bd-btn-block" onClick={handleSubmit} disabled={!canSubmit}>
          {submitState.status === 'submitting' ? '提交中…' : `提交${validCount > 0 ? `（新增 ${classification.creates.length} · 更新 ${updateCount}）` : ''}`}
        </button>

        {submitState.status === 'ok' && <div className="bd-notice">{submitState.message}</div>}
        {submitState.status === 'error' && (
          <div className="bd-notice bd-notice-error">{submitState.message}</div>
        )}
      </div>
    </div>
  )
}
