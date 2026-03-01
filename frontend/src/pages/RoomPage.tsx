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
import EmojiReactions from '../components/EmojiReactions'
import SquatMeter from '../components/SquatMeter'

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
          <EmojiReactions room={livekitRoom} />
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

        <SquatMeter
          fullSquatPercent={fullSquatPercent}
          repCount={repCount}
          goal={SQUAT_GOAL}
          phase={phase}
          isCalibrated={isCalibrated}
          calibrationProgress={calibrationProgress}
        />

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

        <SquatMeter
          fullSquatPercent={progress.fullSquatPercent}
          repCount={progress.repCount}
          goal={SQUAT_GOAL}
          phase={progress.phase}
          isCalibrated={progress.isCalibrated}
          goalComplete={goalComplete}
        />

        <div className="camera-wrap">
          <div ref={videoAttachRef} className="viewer-video-container" />
          {!hasVideo && (
            <div className="camera-overlay">
              Waiting for @{roomInfo.prAuthor} to start their camera...
            </div>
          )}
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
