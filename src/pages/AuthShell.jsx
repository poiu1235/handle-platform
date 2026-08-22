import { Turnstile } from '@marsidev/react-turnstile'

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
                  onError={() => onCaptcha('')}
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