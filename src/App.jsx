import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/AuthContext'
import Login from './pages/Login'
import AuthCallback from './pages/AuthCallback'
import Hello from './pages/Hello'
import BalanceImport from './pages/BalanceImport'

function RequireAuth({ children }) {
  const { session, loading, isRecovery } = useAuth()

  if (loading) {
    return (
      <div className="shell">
        <main className="shell-main">
          <div className="status-line">
            <span className="status-dot status-dot-pending" />
            正在检查登录状态…
          </div>
        </main>
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  // 密码重置邮件产生的恢复态 session 只能用来设置新密码，
  // 不能被当作正常登录态放行到其他业务页面
  if (isRecovery) {
    return <Navigate to="/login" replace />
  }

  return children
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <Hello />
            </RequireAuth>
          }
        />
        <Route
          path="/balance-import"
          element={
            <RequireAuth>
              <BalanceImport />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  )
}