import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import { supabase } from '../lib/supabaseClient'

// ---------- 解析粘贴文本 ----------
// 每行一条，"小程序名" 和 "余额" 之间用 Tab / 逗号 / 多个空格分隔，
// 兼容直接从 Excel、飞书表格、小程序后台复制两列的情况。

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
      // 第一行如果解析不出数字，当作表头处理，直接跳过而不报错
      if (idx === 0) return
      errors.push({ line: idx + 1, raw: line, reason: `余额「${amountRaw}」不是有效数字` })
      return
    }

    rows.push({ app_name: name, amount })
  })

  return { rows, errors }
}

// 同一批次里名称重复时保留最后一条，避免一次 upsert 里出现重复 key
function dedupeRows(rows) {
  const map = new Map()
  rows.forEach((r) => map.set(r.app_name, r))
  return Array.from(map.values())
}

export default function BalanceImport() {
  const { user, signOut } = useAuth()
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

    // 同一批次统一一个时间戳，代表"这批数据是这一刻提交的"
    const submitTime = new Date().toISOString()
    const payload = deduped.map((r) => ({
      user_id: user.id,
      app_name: r.app_name,
      amount: r.amount,
      updated_at: submitTime,
    }))

    const { error, data } = await supabase
      .from('balances')
      .upsert(payload, { onConflict: 'user_id,app_name' })
      .select('id')

    if (error) {
      setSubmitState({ status: 'error', message: error.message })
      return
    }

    setSubmitState({
      status: 'ok',
      message: `已提交 ${data?.length ?? payload.length} 条，相同小程序名已覆盖，新名称已新增`,
    })
    setRawText('')
  }

  return (
    <div className="import-shell">
      <header className="import-header">
        <div className="import-header-top">
          <div>
            <p className="ledger-eyebrow">Balance Import</p>
            <h1 className="board-title">余额批量导入</h1>
          </div>
          <div className="board-header-actions">
            <Link className="text-btn" to="/">
              返回台账
            </Link>
            <button className="text-btn" onClick={signOut}>
              退出登录
            </button>
          </div>
        </div>
        <p className="import-hint">
          从表格里复制两列（小程序名、余额）直接粘贴到下方，每行一条。相同名称会覆盖原有余额，新名称会新增一条记录，更新时间统一记为本次提交时刻。
        </p>
      </header>

      <div className="import-body">
        <textarea
          className="import-textarea"
          placeholder={'小程序名\t余额\n黄金会员小程序\t8600\n视频会员小程序\t120'}
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          rows={10}
        />

        {rawText.trim().length > 0 && (
          <div className="import-preview">
            <p className="import-preview-title">
              解析预览{deduped.length > 0 && `（${deduped.length} 条）`}
              {hasDuplicates && (
                <span className="import-preview-note">同批次内有重名，已保留最后一条</span>
              )}
            </p>

            {errors.length > 0 && (
              <div className="import-errors">
                {errors.map((e, i) => (
                  <p key={i} className="import-error-line">
                    第 {e.line} 行：{e.reason} —「{e.raw}」
                  </p>
                ))}
              </div>
            )}

            {deduped.length > 0 && (
              <table className="import-table">
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

        <button className="btn" onClick={handleSubmit} disabled={!canSubmit}>
          {submitState.status === 'submitting' ? '提交中…' : '提交'}
        </button>

        {submitState.status === 'ok' && <div className="notice">{submitState.message}</div>}
        {submitState.status === 'error' && (
          <div className="notice notice-error">{submitState.message}</div>
        )}
      </div>
    </div>
  )
}