import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

type Repo = {
  id: number
  name: string
  fullName: string
  owner: string
  isPrivate: boolean
  description: string | null
}

type WatchedRepo = { owner: string; repo: string }

type RoomInfo = {
  roomId: string
  repoOwner: string
  repoName: string
  prNumber: number
  prAuthor: string
  squatCount: number
  isMerged: boolean
}

type UserInfo = {
  isAuthenticated: boolean
  login: string
  avatarUrl: string
}

export default function DashboardPage() {
  const navigate = useNavigate()
  const [user, setUser] = useState<UserInfo | null>(null)
  const [repos, setRepos] = useState<Repo[]>([])
  const [watched, setWatched] = useState<WatchedRepo[]>([])
  const [activeRooms, setActiveRooms] = useState<RoomInfo[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [watchingRepo, setWatchingRepo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const [meRes, repoRes, watchRes, roomRes] = await Promise.all([
        fetch('/api/auth/me'),
        fetch('/api/repos'),
        fetch('/api/repos/watched'),
        fetch('/api/rooms'),
      ])

      const me = await meRes.json()
      if (!me.isAuthenticated) {
        navigate('/')
        return
      }
      setUser(me)

      if (repoRes.ok) setRepos(await repoRes.json())
      if (watchRes.ok) setWatched(await watchRes.json())
      if (roomRes.ok) setActiveRooms(await roomRes.json())
    } catch {
      setError('Failed to load data.')
    } finally {
      setLoading(false)
    }
  }, [navigate])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const watchRepo = async (owner: string, repo: string) => {
    setWatchingRepo(`${owner}/${repo}`)
    setError(null)
    try {
      const res = await fetch(`/api/repos/${owner}/${repo}/watch`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.detail ?? 'Failed to watch repository.')
      }
      setWatched((prev) => [...prev, { owner, repo }])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to watch repository.')
    } finally {
      setWatchingRepo(null)
    }
  }

  const unwatchRepo = async (owner: string, repo: string) => {
    setWatchingRepo(`${owner}/${repo}`)
    setError(null)
    try {
      await fetch(`/api/repos/${owner}/${repo}/watch`, { method: 'DELETE' })
      setWatched((prev) => prev.filter((w) => !(w.owner === owner && w.repo === repo)))
    } catch {
      setError('Failed to unwatch repository.')
    } finally {
      setWatchingRepo(null)
    }
  }

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    navigate('/')
  }

  const isWatched = (owner: string, repo: string) =>
    watched.some((w) => w.owner === owner && w.repo === repo)

  const filteredRepos = repos.filter(
    (r) =>
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.fullName.toLowerCase().includes(search.toLowerCase()),
  )

  if (loading) {
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

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="dashboard-header-row">
          <div className="dashboard-user">
            {user?.avatarUrl && (
              <img src={user.avatarUrl} alt="" className="user-avatar" />
            )}
            <span className="user-login">{user?.login}</span>
          </div>
          <h1 className="app-title">Squat-to-Merge</h1>
          <button className="action-button logout-button" onClick={logout} type="button">
            Logout
          </button>
        </div>
      </header>

      <main className="dashboard-content">
        {error && (
          <div className="error-message" role="alert">
            <span>{error}</span>
          </div>
        )}

        {/* Active Rooms */}
        {activeRooms.length > 0 && (
          <section className="dashboard-section">
            <h2 className="section-title">Active Squat Rooms</h2>
            <div className="rooms-grid">
              {activeRooms.map((room) => (
                <div
                  key={room.roomId}
                  className={`room-card ${room.isMerged ? 'room-merged' : ''}`}
                  onClick={() => navigate(`/room/${room.roomId}`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && navigate(`/room/${room.roomId}`)}
                >
                  <div className="room-repo">
                    {room.repoOwner}/{room.repoName}
                  </div>
                  <div className="room-pr">PR #{room.prNumber}</div>
                  <div className="room-author">by @{room.prAuthor}</div>
                  <div className="room-status">
                    {room.isMerged ? '✅ Merged' : `🏋️ ${room.squatCount}/10 squats`}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Watched Repos */}
        {watched.length > 0 && (
          <section className="dashboard-section">
            <h2 className="section-title">Watched Repositories</h2>
            <div className="watched-list">
              {watched.map((w) => (
                <div key={`${w.owner}/${w.repo}`} className="watched-item">
                  <span className="watched-name">
                    {w.owner}/{w.repo}
                  </span>
                  <button
                    className="action-button unwatch-button"
                    onClick={() => unwatchRepo(w.owner, w.repo)}
                    disabled={watchingRepo === `${w.owner}/${w.repo}`}
                    type="button"
                  >
                    Unwatch
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Repo Picker */}
        <section className="dashboard-section">
          <h2 className="section-title">Your Repositories</h2>
          <p className="section-description">
            Watch a repository to enable squat-to-merge for its pull requests.
          </p>
          <input
            type="text"
            className="repo-search"
            placeholder="Search repositories..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="repo-list">
            {filteredRepos.map((r) => {
              const watching = isWatched(r.owner, r.name)
              return (
                <div key={r.id} className="repo-item">
                  <div className="repo-info">
                    <span className="repo-name">{r.fullName}</span>
                    {r.isPrivate && <span className="repo-badge">Private</span>}
                    {r.description && (
                      <span className="repo-description">{r.description}</span>
                    )}
                  </div>
                  <button
                    className={`action-button ${watching ? 'watching' : ''}`}
                    onClick={() =>
                      watching
                        ? unwatchRepo(r.owner, r.name)
                        : watchRepo(r.owner, r.name)
                    }
                    disabled={watchingRepo === `${r.owner}/${r.name}`}
                    type="button"
                  >
                    {watchingRepo === `${r.owner}/${r.name}`
                      ? '...'
                      : watching
                        ? 'Watching ✓'
                        : 'Watch'}
                  </button>
                </div>
              )
            })}
            {filteredRepos.length === 0 && (
              <div className="empty-state" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'flex-start' }}>
                <p>No repositories found.</p>
                <a href="/api/auth/install" className="action-button" style={{ textDecoration: 'none' }}>
                  Install GitHub App
                </a>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
