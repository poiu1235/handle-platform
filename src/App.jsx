import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/AuthContext'
import Login from './pages/Login'
import Register from './pages/Register'
import ForgotPassword from './pages/ForgotPassword'
import ResetPassword from './pages/ResetPassword'
import Hello from './pages/Hello'
import BalanceImport from './pages/BalanceImport'

function RequireAuth({ children }) {
  const { status } = useAuth()

  if (status === 'loading') {
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

  // status 只有三种确定值：anonymous / recovery / authenticated。
  // recovery 态一律回退到 /login（真正合法的去处是 /reset-password，
  // 但那个页面自己会检查 status，这里不需要重复判断该跳去哪）
  if (status !== 'authenticated') {
    return <Navigate to="/login" replace />
  }

  return children
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />

        <Route
          path="/app"
          element={
            <RequireAuth>
              <Hello />
            </RequireAuth>
          }
        />
        <Route
          path="/app/balance-import"
          element={
            <RequireAuth>
              <BalanceImport />
            </RequireAuth>
          }
        />

        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
    </AuthProvider>
  )
}