import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import './App.css'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import RoomPage from './pages/RoomPage'

function AuthGate({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((data) => {
        if (!data.isAuthenticated) navigate('/', { replace: true })
      })
      .catch(() => navigate('/', { replace: true }))
      .finally(() => setChecking(false))
  }, [navigate])

  if (checking) {
    return (
      <div className="app-container">
        <main className="main-content">
          <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
            Loading...
          </div>
        </main>
      </div>
    )
  }

  return <>{children}</>
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<LoginPage />} />
      <Route
        path="/dashboard"
        element={
          <AuthGate>
            <DashboardPage />
          </AuthGate>
        }
      />
      {/* Room page - accessible to anyone (viewers don't need auth) */}
      <Route path="/room/:roomId" element={<RoomPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
