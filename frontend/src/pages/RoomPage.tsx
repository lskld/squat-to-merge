import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  Room,
  RoomEvent,
  Track,
  RemoteTrackPublication,
  RemoteParticipant,
  ConnectionState,
} from 'livekit-client'
import { useSquatDetection, type SquatPhase } from '../hooks/useSquatDetection'

const SQUAT_GOAL = 10

type RoomInfo = {
  roomId: string
  repoOwner: string
  repoName: string
  prNumber: number
  prAuthor: string
  squatCount: number
  isMerged: boolean
  squatGoal: number
}

type TokenInfo = {
  token: string
  url: string
  isSquatter: boolean
  identity: string
}

type ProgressData = {
  type: 'squat_progress'
  repCount: number
  phase: SquatPhase
  fullSquatPercent: number | null
  isCalibrated: boolean
}

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null)
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null)
  const [livekitRoom, setLivekitRoom] = useState<Room | null>(null)
  const [connectionState, setConnectionState] = useState<string>('disconnected')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mergeStatus, setMergeStatus] = useState<string | null>(null)
  const [isMerging, setIsMerging] = useState(false)

  // Fetch room info and token
  useEffect(() => {
    if (!roomId) return
    let cancelled = false

    const load = async () => {
      try {
        const [roomRes, tokenRes] = await Promise.all([
          fetch(`/api/rooms/${roomId}`),
          fetch(`/api/rooms/${roomId}/token`, { method: 'POST' }),
        ])
        if (!roomRes.ok) throw new Error('Room not found.')
        if (!tokenRes.ok) throw new Error('Failed to get room token.')

        const ri: RoomInfo = await roomRes.json()
        const ti: TokenInfo = await tokenRes.json()
        if (cancelled) return
        setRoomInfo(ri)
        setTokenInfo(ti)
      } catch (err) {
        if (!cancelled)
          setLoadError(err instanceof Error ? err.message : 'Failed to load room.')
      }
    }
    load()
    return () => { cancelled = true }
  }, [roomId])

  // Connect to LiveKit
  useEffect(() => {
    if (!tokenInfo?.token || !tokenInfo.url) return
    let room: Room | null = null

    const connect = async () => {
      room = new Room()
      room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
        setConnectionState(state)
      })
      try {
        await room.connect(tokenInfo.url, tokenInfo.token)
        setLivekitRoom(room)
      } catch (err) {
        console.error('LiveKit connection failed: ', err)
        setLoadError('Failed to connect to live room. LiveKit may not be configured.')
      }
    }
    connect()

    return () => {
      room?.disconnect()
      setLivekitRoom(null)
    }
  }, [tokenInfo])

  if (loadError) {
    return (
      <div className="app-container dashboard-shell">
        <main className="dashboard-main" style={{ justifyContent: 'center' }}>
          <div className="dashboard-panel" style={{ textAlign: 'center' }}>
            <div className="dashboard-alert" role="alert">
              <span>{loadError}</span>
            </div>
            <Link
              to="/dashboard"
              className="dashboard-button"
              style={{ marginTop: '0.75rem', display: 'inline-block', textDecoration: 'none' }}
            >
              Back to Dashboard
            </Link>
          </div>
        </main>
      </div>
    )
  }

  if (!roomInfo || !tokenInfo) {
    return (
      <div className="app-container dashboard-shell">
        <main className="dashboard-main" style={{ justifyContent: 'center' }}>
          <div className="dashboard-panel" style={{ textAlign: 'center', padding: '3rem' }}>
            Loading room...
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="app-container dashboard-shell">
      <main className="dashboard-main room-main">
        <header className="room-topbar">
          <div className="room-title-block">
            <div className="room-topline">
              <Link to="/dashboard" className="dashboard-button dashboard-button-ghost">
                Back
              </Link>
              <span className={`connection-badge ${connectionState}`}>{connectionState}</span>
            </div>
            <h1 className="room-title">
              {roomInfo.repoOwner}/{roomInfo.repoName}
            </h1>
            <p className="room-subtitle">PR #{roomInfo.prNumber}</p>
            <p className="dashboard-copy">
              {tokenInfo.isSquatter
                ? 'You are the squatter. Complete 10 squats to merge this pull request.'
                : `Watching @${roomInfo.prAuthor} complete the squat challenge.`}
            </p>
          </div>
        </header>

        <div className="room-content">
          {tokenInfo.isSquatter ? (
            <SquatterView
              room={livekitRoom}
              roomId={roomId!}
              roomInfo={roomInfo}
              mergeStatus={mergeStatus}
              isMerging={isMerging}
              setMergeStatus={setMergeStatus}
              setIsMerging={setIsMerging}
            />
          ) : (
            <ViewerView room={livekitRoom} roomInfo={roomInfo} />
          )}
        </div>
      </main>
    </div>
  )
}

// ─────── Squatter View ───────

function SquatterView({
  room,
  roomId,
  roomInfo,
  mergeStatus,
  isMerging,
  setMergeStatus,
  setIsMerging,
}: {
  room: Room | null
  roomId: string
  roomInfo: RoomInfo
  mergeStatus: string | null
  isMerging: boolean
  setMergeStatus: (s: string | null) => void
  setIsMerging: (b: boolean) => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const publishedRef = useRef(false)
  const mergeTriggeredRef = useRef(false)

  const {
    repCount,
    phase,
    fullSquatPercent,
    isCalibrated,
    calibrationProgress,
    isRunning,
    isStarting,
    error,
    stream,
    startTracking,
    stopTracking,
  } = useSquatDetection(videoRef, canvasRef)

  const fullSquatValue = fullSquatPercent ?? 0
  const fullSquatHue = Math.round((fullSquatValue / 100) * 120)
  const goalProgress = Math.min(100, Math.round((repCount / SQUAT_GOAL) * 100))
  const goalComplete = repCount >= SQUAT_GOAL

  // Publish video track to LiveKit
  useEffect(() => {
    if (!room || !stream || publishedRef.current) return
    const videoTrack = stream.getVideoTracks()[0]
    if (!videoTrack) return

    publishedRef.current = true
    room.localParticipant
      .publishTrack(videoTrack, { source: Track.Source.Camera })
      .catch((err) => console.error('Failed to publish track:', err))

    return () => {
      publishedRef.current = false
    }
  }, [room, stream])

  // Send progress via data channel
  useEffect(() => {
    if (!room || room.state !== ConnectionState.Connected) return
    const data: ProgressData = {
      type: 'squat_progress',
      repCount,
      phase,
      fullSquatPercent,
      isCalibrated,
    }
    const encoded = new TextEncoder().encode(JSON.stringify(data))
    room.localParticipant.publishData(encoded, { reliable: true }).catch(() => {})
  }, [room, repCount, phase, fullSquatPercent, isCalibrated])

  // Auto-merge when goal complete
  useEffect(() => {
    if (!goalComplete || isMerging || mergeTriggeredRef.current || roomInfo.isMerged) return
    mergeTriggeredRef.current = true
    setIsMerging(true)

    fetch(`/api/rooms/${roomId}/complete`, { method: 'POST' })
      .then(async (res) => {
        const data = await res.json()
        setMergeStatus(data.message ?? 'PR merged!')
      })
      .catch(() => setMergeStatus('Failed to merge PR.'))
      .finally(() => setIsMerging(false))
  }, [goalComplete, isMerging, roomId, roomInfo.isMerged, setIsMerging, setMergeStatus])

  return (
    <section className="room-section" aria-labelledby="tracker-heading">
      <div className="dashboard-panel room-panel">
        <div className="room-panel-header">
          <h2 id="tracker-heading" className="room-panel-title">Your squat challenge</h2>
          <button
            className="dashboard-button"
            onClick={isRunning ? stopTracking : startTracking}
            disabled={isStarting || (goalComplete && !isRunning)}
            type="button"
          >
            {isStarting ? 'Starting…' : isRunning ? 'Stop Camera' : 'Start Camera'}
          </button>
        </div>

        {error && (
          <div className="dashboard-alert" role="alert">
            <span>{error}</span>
          </div>
        )}

        {mergeStatus && (
          <div className="room-merge-status" role="status">
            {mergeStatus}
          </div>
        )}

        <div className="camera-wrap">
          <video ref={videoRef} className="camera-video" autoPlay muted playsInline />
          <canvas ref={canvasRef} className="skeleton-canvas" aria-hidden="true" />
          {!isRunning && (
            <div className="camera-overlay" aria-hidden="true">
              {goalComplete
                ? 'Challenge complete. Pull request merged.'
                : 'Start camera to begin the squat challenge.'}
            </div>
          )}
        </div>

        <div className="room-stats-grid" aria-live="polite">
          <div className="room-stat-card">
            <span className="room-stat-label">Status</span>
            <span className={`room-stat-value ${phase === 'squat' ? 'is-squat' : 'is-standing'}`}>
              {phase === 'squat' ? 'In Squat' : 'Standing'}
            </span>
          </div>
          <div className="room-stat-card">
            <span className="room-stat-label">Full Squat</span>
            <span className="room-stat-value">
              {fullSquatPercent !== null ? `${fullSquatPercent}%` : '--'}
            </span>
            <div className="progress-track" aria-hidden="true">
              <div
                className="progress-fill"
                style={{
                  width: `${fullSquatValue}%`,
                  backgroundColor: `hsl(${fullSquatHue} 85% 45%)`,
                }}
              />
            </div>
          </div>
          <div className="room-stat-card">
            <span className="room-stat-label">Squat Reps</span>
            <span className="room-stat-value">
              {Math.min(repCount, SQUAT_GOAL)}/{SQUAT_GOAL}
            </span>
            <div className="progress-track" aria-hidden="true">
              <div className="progress-fill" style={{ width: `${goalProgress}%` }} />
            </div>
            <span className="room-goal-status">
              {goalComplete
                ? isMerging
                  ? 'Merging PR…'
                  : 'Merged'
                : `${SQUAT_GOAL - repCount} to merge`}
            </span>
          </div>
          <div className="room-stat-card">
            <span className="room-stat-label">Calibration</span>
            <span className="room-stat-value">
              {isCalibrated ? 'Ready' : `${calibrationProgress}%`}
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}

// ─────── Viewer View ───────

function ViewerView({
  room,
  roomInfo,
}: {
  room: Room | null
  roomInfo: RoomInfo
}) {
  const videoAttachRef = useRef<HTMLDivElement | null>(null)
  const [progress, setProgress] = useState<ProgressData>({
    type: 'squat_progress',
    repCount: roomInfo.squatCount,
    phase: 'standing',
    fullSquatPercent: null,
    isCalibrated: false,
  })
  const [hasVideo, setHasVideo] = useState(false)

  const handleTrackSubscribed = useCallback(
    (track: any, _pub: RemoteTrackPublication, _participant: RemoteParticipant) => {
      if (track.kind === Track.Kind.Video) {
        const el = track.attach() as HTMLVideoElement
        el.className = 'camera-video viewer-video'
        el.style.width = '100%'
        el.style.borderRadius = '0.75rem'
        const container = videoAttachRef.current
        if (container) {
          // Remove only previously-attached video elements, not React-managed nodes
          Array.from(container.children).forEach((child) => {
            if (child instanceof HTMLVideoElement) {
              child.remove()
            }
          })
          container.appendChild(el)
        }
        setHasVideo(true)
      }
    },
    [],
  )

  const handleTrackUnsubscribed = useCallback(
    (track: any) => {
      if (track.kind === Track.Kind.Video) {
        track.detach().forEach((el: HTMLElement) => el.remove())
        setHasVideo(false)
      }
    },
    [],
  )

  const handleDataReceived = useCallback(
    (payload: Uint8Array) => {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload))
        if (data.type === 'squat_progress') {
          setProgress(data)
        }
      } catch {}
    },
    [],
  )

  useEffect(() => {
    if (!room) return

    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed)
    room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed)
    room.on(RoomEvent.DataReceived, handleDataReceived)

    // Handle already-subscribed tracks
    room.remoteParticipants.forEach((p) => {
      p.trackPublications.forEach((pub) => {
        if (pub.track && pub.track.kind === Track.Kind.Video) {
          handleTrackSubscribed(pub.track, pub as RemoteTrackPublication, p)
        }
      })
    })

    return () => {
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed)
      room.off(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed)
      room.off(RoomEvent.DataReceived, handleDataReceived)
    }
  }, [room, handleTrackSubscribed, handleTrackUnsubscribed, handleDataReceived])

  const fullSquatValue = progress.fullSquatPercent ?? 0
  const fullSquatHue = Math.round((fullSquatValue / 100) * 120)
  const goalProgress = Math.min(100, Math.round((progress.repCount / SQUAT_GOAL) * 100))
  const goalComplete = progress.repCount >= SQUAT_GOAL || roomInfo.isMerged

  return (
    <section className="room-section" aria-labelledby="viewer-heading">
      <div className="dashboard-panel room-panel">
        <div className="room-panel-header">
          <h2 id="viewer-heading" className="room-panel-title">
            Watching @{roomInfo.prAuthor}
          </h2>
          <span className="dashboard-pill">Viewer</span>
        </div>

        <div className="camera-wrap">
          <div ref={videoAttachRef} className="viewer-video-container" />
          {!hasVideo && (
            <div className="camera-overlay">
              Waiting for @{roomInfo.prAuthor} to start their camera...
            </div>
          )}
        </div>

        <div className="room-stats-grid" aria-live="polite">
          <div className="room-stat-card">
            <span className="room-stat-label">Status</span>
            <span
              className={`room-stat-value ${progress.phase === 'squat' ? 'is-squat' : 'is-standing'}`}
            >
              {goalComplete
                ? 'Done'
                : progress.phase === 'squat'
                  ? 'In Squat'
                  : 'Standing'}
            </span>
          </div>
          <div className="room-stat-card">
            <span className="room-stat-label">Full Squat</span>
            <span className="room-stat-value">
              {progress.fullSquatPercent !== null ? `${progress.fullSquatPercent}%` : '--'}
            </span>
            <div className="progress-track" aria-hidden="true">
              <div
                className="progress-fill"
                style={{
                  width: `${fullSquatValue}%`,
                  backgroundColor: `hsl(${fullSquatHue} 85% 45%)`,
                }}
              />
            </div>
          </div>
          <div className="room-stat-card">
            <span className="room-stat-label">Squat Reps</span>
            <span className="room-stat-value">
              {Math.min(progress.repCount, SQUAT_GOAL)}/{SQUAT_GOAL}
            </span>
            <div className="progress-track" aria-hidden="true">
              <div className="progress-fill goal-fill" style={{ width: `${goalProgress}%` }} />
            </div>
            <span className="room-goal-status">
              {goalComplete ? 'PR merged' : `${SQUAT_GOAL - progress.repCount} to go`}
            </span>
          </div>
          <div className="room-stat-card">
            <span className="room-stat-label">Calibration</span>
            <span className="room-stat-value">
              {progress.isCalibrated ? 'Ready' : 'Calibrating...'}
            </span>
          </div>
        </div>

        {goalComplete && (
          <div className="room-merge-note">
            <p>Challenge complete. The pull request has been merged.</p>
          </div>
        )}
      </div>
    </section>
  )
}
