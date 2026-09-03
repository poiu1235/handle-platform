import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/AuthContext'
import { initCardsSession } from './lib/cardsStore'
import Login from './pages/Login'
import Register from './pages/Register'
import ForgotPassword from './pages/ForgotPassword'
import ResetPassword from './pages/ResetPassword'
import Hello from './pages/Hello'
import BalanceImport from './pages/BalanceImport'
import CardsImport from './pages/CardsImport'

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

// 会员进站会话引导（3.3.3 / 4-B37）：会话必须挂在 App 根级别——/app 与
// /app/cards-import 是兄弟路由，往返会重挂路由组件，而 PRD 明确"路由跳转
// 不是进站"；会话随 App（页面加载）存活，登录态就绪后启动（含跨天监听）。
function CardsSessionBootstrap() {
  const { status, user } = useAuth()

  useEffect(() => {
    if (status === 'authenticated' && user?.id) initCardsSession(user.id)
  }, [status, user?.id])

  return null
}

export default function App() {
  return (
    <AuthProvider>
      <CardsSessionBootstrap />
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
        <Route
          path="/app/cards-import"
          element={
            <RequireAuth>
              <CardsImport />
            </RequireAuth>
          }
        />

        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
    </AuthProvider>
  )
}