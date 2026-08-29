import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import * as api from '../lib/apiClient'
import './board.css'

// ============================================================
// 余额批量导入页：粘贴解析 / 逐行报错 / 表头跳过 / 同批重名去重 /
// 解析预览表格 / 提交与结果提示。样式见 ./board.css（bd- 前缀）。
// ============================================================

function splitLine(line) {
  if (line.includes('\t')) return line.split('\t')
  if (line.includes(',')) return line.split(',')
  return line.trim().split(/\s+/)
}

function parsePastedText(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  const rows = []
  const errors = []

  lines.forEach((line, idx) => {
    const parts = splitLine(line)
      .map((p) => p.trim())
      .filter(Boolean)

    if (parts.length < 2) {
      errors.push({ line: idx + 1, raw: line, reason: '缺少字段（需要 名称 和 余额 两列）' })
      return
    }

    const [name, amountRaw] = parts
    const amount = Number(amountRaw.replace(/,/g, ''))

    if (!name) {
      errors.push({ line: idx + 1, raw: line, reason: '小程序名为空' })
      return
    }
    if (Number.isNaN(amount)) {
      if (idx === 0) return
      errors.push({ line: idx + 1, raw: line, reason: `余额「${amountRaw}」不是有效数字` })
      return
    }

    rows.push({ app_name: name, amount })
  })

  return { rows, errors }
}

function dedupeRows(rows) {
  const map = new Map()
  rows.forEach((r) => map.set(r.app_name, r))
  return Array.from(map.values())
}

export default function BalanceImport() {
  const { user, logout } = useAuth()
  const [rawText, setRawText] = useState('')
  const [submitState, setSubmitState] = useState({ status: 'idle', message: '' })

  const { rows, errors } = useMemo(() => parsePastedText(rawText), [rawText])
  const deduped = useMemo(() => dedupeRows(rows), [rows])
  const hasDuplicates = deduped.length !== rows.length

  const canSubmit =
    deduped.length > 0 && errors.length === 0 && submitState.status !== 'submitting'

  async function handleSubmit() {
    if (!user) {
      setSubmitState({ status: 'error', message: '未登录，无法提交' })
      return
    }
    setSubmitState({ status: 'submitting', message: '' })

    const submitTime = new Date().toISOString()
    const rows = deduped.map((r) => ({
      app_name: r.app_name,
      amount: r.amount,
      updated_at: submitTime,
    }))

    try {
      const res = await api.authorizedFetch('/api/balances/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `提交失败（${res.status}）`)

      setSubmitState({
        status: 'ok',
        message: `已提交 ${Array.isArray(body) ? body.length : rows.length} 条，相同小程序名已覆盖，新名称已新增`,
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
            <p className="bd-eyebrow">Balance Import</p>
            <h1 className="bd-title">余额批量导入</h1>
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
          从表格里复制两列（小程序名、余额）直接粘贴到下方，每行一条。相同名称会覆盖原有余额，新名称会新增一条记录，更新时间统一记为本次提交时刻。
        </p>
      </header>

      <div className="bd-import-body">
        <textarea
          className="bd-textarea"
          placeholder={'小程序名\t余额\n黄金会员小程序\t8600\n视频会员小程序\t120'}
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          rows={10}
        />

        {rawText.trim().length > 0 && (
          <div className="bd-preview">
            <p className="bd-preview-title">
              解析预览{deduped.length > 0 && `（${deduped.length} 条）`}
              {hasDuplicates && (
                <span className="bd-preview-note">同批次内有重名，已保留最后一条</span>
              )}
            </p>

            {errors.length > 0 && (
              <div className="bd-errors">
                {errors.map((e, i) => (
                  <p key={i} className="bd-error-line">
                    第 {e.line} 行：{e.reason} —「{e.raw}」
                  </p>
                ))}
              </div>
            )}

            {deduped.length > 0 && (
              <table className="bd-table">
                <thead>
                  <tr>
                    <th>小程序名</th>
                    <th>余额</th>
                  </tr>
                </thead>
                <tbody>
                  {deduped.map((r) => (
                    <tr key={r.app_name}>
                      <td>{r.app_name}</td>
                      <td>{r.amount.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        <button className="bd-btn bd-btn-block" onClick={handleSubmit} disabled={!canSubmit}>
          {submitState.status === 'submitting' ? '提交中…' : '提交'}
        </button>

        {submitState.status === 'ok' && <div className="bd-notice">{submitState.message}</div>}
        {submitState.status === 'error' && (
          <div className="bd-notice bd-notice-error">{submitState.message}</div>
        )}
      </div>
    </div>
  )
}
