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
      <div className="app-container dashboard-shell">
        <main className="dashboard-main" style={{ justifyContent: 'center' }}>
          <div className="dashboard-panel" style={{ textAlign: 'center', padding: '3rem' }}>
            Loading...
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="app-container dashboard-shell">
      <main className="dashboard-main">
        <header className="dashboard-topbar">
          <div className="dashboard-branding">
            <h1 className="dashboard-title">Squat-to-Merge</h1>
            <p className="dashboard-subtitle">GitHub App dashboard</p>
          </div>
          <div className="dashboard-account">
            {user?.avatarUrl && <img src={user.avatarUrl} alt="" className="user-avatar" />}
            <span className="user-login">@{user?.login}</span>
            <button
              className="dashboard-button dashboard-button-ghost"
              onClick={logout}
              type="button"
            >
              Log out
            </button>
          </div>
        </header>

        {error && (
          <div className="dashboard-alert" role="alert">
            <span>{error}</span>
          </div>
        )}

        {activeRooms.length > 0 && (
          <section className="dashboard-panel">
            <div className="dashboard-section-head">
              <h2 className="dashboard-section-title">Active rooms</h2>
              <span className="dashboard-meta">{activeRooms.length}</span>
            </div>
            <div className="dashboard-list">
              {activeRooms.map((room) => (
                <button
                  key={room.roomId}
                  className="dashboard-room"
                  onClick={() => navigate(`/room/${room.roomId}`)}
                  type="button"
                >
                  <div className="dashboard-room-main">
                    <span className="dashboard-room-repo">
                      {room.repoOwner}/{room.repoName}
                    </span>
                    <span className="dashboard-room-pr">PR #{room.prNumber}</span>
                    <span className="dashboard-room-author">@{room.prAuthor}</span>
                  </div>
                  <span className={`dashboard-pill ${room.isMerged ? 'is-success' : ''}`}>
                    {room.isMerged ? 'Merged' : `${room.squatCount}/10 squats`}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {watched.length > 0 && (
          <section className="dashboard-panel">
            <div className="dashboard-section-head">
              <h2 className="dashboard-section-title">Watched repositories</h2>
              <span className="dashboard-meta">{watched.length}</span>
            </div>
            <div className="dashboard-list">
              {watched.map((w) => (
                <div key={`${w.owner}/${w.repo}`} className="dashboard-row">
                  <span className="dashboard-row-title">
                    {w.owner}/{w.repo}
                  </span>
                  <button
                    className="dashboard-button dashboard-button-danger"
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

        <section className="dashboard-panel">
          <div className="dashboard-section-head">
            <h2 className="dashboard-section-title">Repositories</h2>
            <span className="dashboard-meta">{filteredRepos.length}</span>
          </div>
          <p className="dashboard-copy">Watch a repository to enable squat-to-merge for pull requests.</p>
          <input
            type="text"
            className="repo-search"
            placeholder="Search repositories..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="dashboard-list">
            {filteredRepos.map((r) => {
              const watching = isWatched(r.owner, r.name)
              return (
                <div key={r.id} className="dashboard-row">
                  <div className="dashboard-row-main">
                    <div className="dashboard-row-title-group">
                      <span className="dashboard-row-title">{r.fullName}</span>
                      {r.isPrivate && <span className="dashboard-pill">Private</span>}
                    </div>
                    {r.description && <span className="dashboard-row-copy">{r.description}</span>}
                  </div>
                  <button
                    className={`dashboard-button ${watching ? 'dashboard-button-success' : ''}`}
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
                        ? 'Watching'
                        : 'Watch'}
                  </button>
                </div>
              )
            })}
            {filteredRepos.length === 0 && (
              <div className="empty-state" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'flex-start' }}>
                <p>No repositories found.</p>
                <a
                  href="/api/auth/install"
                  className="dashboard-button"
                  style={{ textDecoration: 'none' }}
                >
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
