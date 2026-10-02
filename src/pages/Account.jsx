import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import * as api from '../lib/apiClient'
import { useAutoDismiss } from '../lib/useAutoDismiss'
import { buildNotesExport, exportFileName } from '../lib/notesExport'
import { XLSX_MIME, buildXlsx } from '../lib/xlsxWriter'
import { todayISO } from '../../shared/notesDomain.js'
import './account.css'

// ============================================================
// 账户信息页（对齐小程序 pages/account/index）：当前身份 + 微信绑定管理 +
// 注销账号，并收留从首页头部迁下来的「退出登录」。
//
// 小程序那页的「客服」栏用微信原生 open-type=contact（会话式客服），Web 没有
// 对应能力，这一栏不搬。
//
// 两条离开本页的路径都由服务端会话状态定调：
//   解绑 = 服务端已 revoke 该账号全部会话（B28）→ 本地只做收尾（endSession），
//          不能再发 /logout，手上的 refresh token 已经死了；
//   注销 = 7 天冷静期入队，会话本身合法存续，所以走正常 logout。
// 两者最后都回到 /login，重新登录即撤销注销申请（设计 2.3）。
//
// 确认区一律内联、不弹窗：密码输入要和说明文案在同一口气里读完，
// 弹窗反而把两者拆散（小程序那边是 showModal 收不了输入才被迫内联，这里内联
// 是更直接的形态）。
//
// 「便利贴导出」是一条只读旁路：点一下才发一次 GET /api/notes（与面板同一读路径），
// 表构建与 .xlsx 组装全在浏览器里（src/lib/notesExport.js、src/lib/xlsxWriter.js），
// 不写库、不触发清除、后端零改动——摘掉这个按钮，其它链路不受任何影响。
// ============================================================

const PROVIDER_LABELS = { wechat_mp: '微信' }
const dateOnly = (iso) => (iso || '').slice(0, 10)

// 解绑/注销后先把话说完再收尾会话的停留时长（与小程序同一节奏）
const TEARDOWN_DELAY_MS = 900

// 字节流落成浏览器下载。revokeObjectURL 放在下一拍而不是 click() 之后同步执行：
// click 只是发起下载，数据的实际读取由浏览器随后完成，提前释放就断了来源
function saveToDisk(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function Account() {
  const { user, logout, endSession } = useAuth()
  const [identities, setIdentities] = useState([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  // 'unbind' | 'delete' | null：内联密码确认区的模式机，两栏共用一个 password，
  // 所以切换模式时必须清空（beginAction / cancelAction 成对处理）
  const [mode, setMode] = useState(null)
  const [targetProvider, setTargetProvider] = useState('')
  const [password, setPassword] = useState('')
  // 导出自成一路：不借用 unbind/delete 的 mode 机与 busy——那两个动作会收尾会话，
  // 导出只读数据，进行中态串在一起会让一个按钮的禁用跟着另一条路径走
  const [exporting, setExporting] = useState(false)
  useAutoDismiss(error, setError)
  useAutoDismiss(notice, setNotice)

  const teardownTimer = useRef(null)
  useEffect(() => () => clearTimeout(teardownTimer.current), [])

  useEffect(() => {
    api
      .fetchIdentities()
      .then((data) => setIdentities(data?.identities ?? []))
      .catch((err) => setError(err.message || '绑定状态读取失败'))
  }, [])

  function beginAction(next, provider = '') {
    setMode(next)
    setTargetProvider(provider)
    setPassword('')
    setError('')
  }

  function cancelAction() {
    setMode(null)
    setPassword('')
    setBusy(false)
  }

  // 人中途走了（点返回管理端）→ 上面的 cleanup 清掉定时器，不会在事后补刀。
  // 此时本地残留的 token 已被服务端吊销，下一次业务请求 401 会由 authorizedFetch
  // 收尾并送回登录页，不会停在假登录态。
  function scheduleTeardown(teardown) {
    teardownTimer.current = setTimeout(teardown, TEARDOWN_DELAY_MS)
  }

  async function handleUnbind() {
    if (!password) return setError('请输入当前账号密码')
    setBusy(true)
    try {
      await api.unbindIdentity(targetProvider, password)
      setNotice('已解绑，所有设备需重新登录')
      scheduleTeardown(endSession)
    } catch (err) {
      setError(err.message || '解绑失败')
      setBusy(false)
    }
  }

  async function handleDelete() {
    if (!password) return setError('请输入当前账号密码')
    setBusy(true)
    try {
      const data = await api.deleteAccount(password)
      setNotice(
        `注销申请已提交：账号将在 ${dateOnly(data.purgeAfter)} 被清除，在此之前重新登录即自动撤销。`
      )
      scheduleTeardown(logout)
    } catch (err) {
      setError(err.message || '注销申请失败')
      setBusy(false)
    }
  }

  async function handleExport() {
    if (exporting) return
    setExporting(true)
    setError('')
    setNotice('')
    try {
      const res = await api.authorizedFetch('/api/notes')
      const body = await res.json().catch(() => [])
      if (!res.ok) throw new Error(body?.error || `便利贴读取失败（${res.status}）`)

      const today = todayISO()
      const { sheet, exported, cleared } = buildNotesExport(body, today)
      if (exported === 0) {
        setNotice(cleared > 0 ? `便利贴都已到清除时刻（${cleared} 条），没有可导出的内容` : '还没有便利贴')
        return
      }
      saveToDisk(buildXlsx(sheet), exportFileName(today))
      setNotice(
        `已导出 ${exported} 条${cleared > 0 ? `（另有 ${cleared} 条已过清除时刻，未包含）` : ''}`
      )
    } catch (err) {
      setError(err.message || '导出失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="bd-import acc-page">
      <header className="bd-import-header">
        <div className="bd-import-top">
          <div>
            <p className="bd-eyebrow">Account</p>
            <h1 className="bd-title">账户信息</h1>
          </div>
          <div className="bd-header-actions">
            <Link className="bd-text-btn" to="/app">
              返回管理端
            </Link>
          </div>
        </div>
      </header>

      <div className="bd-import-body">
        <section className="acc-panel">
          <h2 className="acc-panel-title">当前身份</h2>
          <div className="acc-row">
            <span className="acc-row-label">邮箱账号</span>
            <span className="acc-row-state acc-row-email">{user?.email || ''}</span>
          </div>
          <button className="acc-btn" onClick={logout}>
            退出登录
          </button>
        </section>

        <section className="acc-panel">
          <h2 className="acc-panel-title">微信绑定</h2>
          {identities.length === 0 && (
            <p className="acc-hint">
              尚未绑定微信。回到微信小程序将自动进入访客身份，可在访客态发起绑定。
            </p>
          )}
          {identities.map((row) => (
            <div className="acc-row" key={row.provider}>
              <span className="acc-row-label">{PROVIDER_LABELS[row.provider] || row.provider}</span>
              <span className="acc-row-state">{dateOnly(row.bound_at)} 起</span>
              {mode !== 'delete' && (
                <button
                  className="acc-link-danger"
                  onClick={() => beginAction('unbind', row.provider)}
                >
                  {mode === 'unbind' && targetProvider === row.provider ? '进行中' : '解绑'}
                </button>
              )}
            </div>
          ))}

          {mode === 'unbind' && (
            <div className="acc-confirm">
              <p className="acc-hint">
                解绑=拆掉微信到本账号的门：微信端会回到全新访客身份；本账号数据不动。
                解绑将强制所有设备重新登录（防被盗会话滞留），本页也会一并退出。
                换到别的邮箱账号：先解绑，再到新账号所在微信里重新发起绑定。
              </p>
              <input
                className="acc-input"
                type="password"
                autoComplete="current-password"
                placeholder="输入当前账号密码确认"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <div className="acc-btn-row">
                <button className="acc-btn" disabled={busy} onClick={handleUnbind}>
                  {busy ? '处理中…' : '确认解绑'}
                </button>
                <button className="acc-btn acc-btn-ghost" onClick={cancelAction}>
                  取消
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="acc-panel">
          <h2 className="acc-panel-title">便利贴导出</h2>
          <p className="acc-hint">
            把灵感与备忘汇总成一张 Excel 表下载到本地：正常、已过期、已完成都在内，
            列含类型、内容、状态、截止日期、置顶与创建/完成时间。
            页面上已到达清除时刻的条目不导出（它们也已经从面板消失）。
          </p>
          <button className="acc-btn" disabled={exporting} onClick={handleExport}>
            {exporting ? '导出中…' : '导出 Excel'}
          </button>
        </section>

        <section className="acc-panel">
          <h2 className="acc-panel-title">注销账号</h2>
          <p className="acc-hint">
            提交后进入 7 天冷静期：期间重新登录即撤销；到期数据永久删除且不可恢复。
          </p>
          {mode === 'delete' ? (
            <div className="acc-confirm">
              <input
                className="acc-input"
                type="password"
                autoComplete="current-password"
                placeholder="输入当前账号密码确认"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <div className="acc-btn-row">
                <button
                  className="acc-btn acc-btn-danger"
                  disabled={busy}
                  onClick={handleDelete}
                >
                  {busy ? '处理中…' : '确认注销'}
                </button>
                <button className="acc-btn acc-btn-ghost" onClick={cancelAction}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button className="acc-btn acc-btn-danger" onClick={() => beginAction('delete')}>
              注销账号
            </button>
          )}
        </section>

        {notice && <div className="bd-notice">{notice}</div>}
        {error && <div className="bd-notice bd-notice-error">{error}</div>}
      </div>
    </div>
  )
}
