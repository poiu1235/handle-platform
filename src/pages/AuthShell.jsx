import { Turnstile } from '@marsidev/react-turnstile'
import '../auth.css'

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY

export default function AuthShell({
  eyebrow,
  title,
  notice,
  error,
  children,
  onSubmit,
  submitLabel,
  submitDisabled,
  showCaptcha = true,
  onCaptcha,
  captchaRef,
}) {
  return (
    <div className="shell">
      <header className="shell-header">
        <div className="brand">
          <span className="brand-mark" />
          Handle 数据管理端
        </div>
        <span className="brand-sub">Handle Platform</span>
      </header>

      <main className="shell-main">
        <div className="ledger-card">
          <p className="ledger-eyebrow">{eyebrow}</p>
          <h1 className="ledger-title">{title}</h1>

          {notice && <div className="notice">{notice}</div>}
          {error && <div className="notice notice-error">{error}</div>}

          <form onSubmit={onSubmit}>
            {children}

            {showCaptcha && (
              <div className="field">
                <Turnstile
                  ref={captchaRef}
                  siteKey={TURNSTILE_SITE_KEY}
                  onSuccess={onCaptcha}
                  onExpire={() => onCaptcha('')}
                  onError={() => {
                    // 只清本地 token 不够——widget 本身也可能卡在加载失败的状态里，
                    // 不主动 reset() 的话就要等用户手动刷新整个页面才能恢复。
                    // Turnstile 自带的 retry:'auto' 只处理它内部能感知到的失败，
                    // 这里 onError 触发时额外主动 reset 一次，是官方文档推荐的兜底写法
                    onCaptcha('')
                    captchaRef?.current?.reset()
                  }}
                />
              </div>
            )}

            <button className="btn" type="submit" disabled={submitDisabled}>
              {submitLabel}
            </button>
          </form>
        </div>
      </main>
    </div>
  )
}