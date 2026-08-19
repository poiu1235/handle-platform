import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/AuthContext'
import Login from './pages/Login'
import AuthCallback from './pages/AuthCallback'
import Hello from './pages/Hello'

function RequireAuth({ children }) {
  const { session, loading } = useAuth()

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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  )
}
