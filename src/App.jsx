import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/AuthContext'
import Login from './pages/Login'
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

  // 密码重置流程中，验证码验证通过后会先建立一个恢复态 session，只能用来设置新密码，
  // 不能被当作正常登录态放行到其他业务页面（防止有人验证码过了但没设完新密码就跑掉）
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