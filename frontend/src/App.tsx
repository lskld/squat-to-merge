import { useCallback, useEffect, useRef, useState } from 'react'
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import { createLocalTracks, Room, RoomEvent, Track } from 'livekit-client'
import './App.css'

type SquatPhase = 'standing' | 'squat'

type Point3D = {
  x: number
  y: number
  z: number
}

type LiveRole = 'squatter' | 'viewer'

type LiveProgressPayload = {
  type: 'progress'
  phase: SquatPhase
  fullSquatPercent: number | null
  repCount: number
  calibrationProgress: number
  isCalibrated: boolean
}

type LiveReactionPayload = {
  type: 'reaction'
  emoji: string
  participantName: string
}

type LiveDataPayload = LiveProgressPayload | LiveReactionPayload

type LiveReaction = {
  id: string
  emoji: string
  participantName: string
}

const LEFT_HIP = 23
const RIGHT_HIP = 24
const LEFT_SHOULDER = 11
const RIGHT_SHOULDER = 12
const LEFT_KNEE = 25
const RIGHT_KNEE = 26
const LEFT_ANKLE = 27
const RIGHT_ANKLE = 28

const LANDMARK_VISIBILITY_THRESHOLD = 0.35
const ANGLE_SMOOTHING_ALPHA = 0.2
const DEPTH_SMOOTHING_ALPHA = 0.25
const SHOULDER_DROP_SMOOTHING_ALPHA = 0.25
const CALIBRATION_FRAME_TARGET = 45
const CALIBRATION_MIN_FRAMES = 15
const DOWN_HOLD_MS = 120
const UP_HOLD_MS = 180
const MIN_REP_DURATION_MS = 700
const FALLBACK_SQUAT_ANGLE_THRESHOLD = 118
const FALLBACK_STAND_ANGLE_THRESHOLD = 152
const FALLBACK_SQUAT_SHOULDER_DROP_THRESHOLD = 0.28
const FALLBACK_STAND_SHOULDER_DROP_THRESHOLD = 0.025
const SQUAT_GOAL = 10
const REACTION_EMOJIS = ['🔥', '👏', '💪', '🙌', '🎉']

const SKELETON_CONNECTIONS: Array<[number, number]> = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
]

const angleAtJoint = (firstPoint: Point3D, jointPoint: Point3D, thirdPoint: Point3D) => {
  const firstVectorX = firstPoint.x - jointPoint.x
  const firstVectorY = firstPoint.y - jointPoint.y
  const firstVectorZ = firstPoint.z - jointPoint.z

  const secondVectorX = thirdPoint.x - jointPoint.x
  const secondVectorY = thirdPoint.y - jointPoint.y
  const secondVectorZ = thirdPoint.z - jointPoint.z

  const dotProduct =
    firstVectorX * secondVectorX +
    firstVectorY * secondVectorY +
    firstVectorZ * secondVectorZ

  const firstMagnitude = Math.sqrt(
    firstVectorX * firstVectorX +
      firstVectorY * firstVectorY +
      firstVectorZ * firstVectorZ,
  )
  const secondMagnitude = Math.sqrt(
    secondVectorX * secondVectorX +
      secondVectorY * secondVectorY +
      secondVectorZ * secondVectorZ,
  )

  if (!firstMagnitude || !secondMagnitude) {
    return 180
  }

  const cosine = Math.max(-1, Math.min(1, dotProduct / (firstMagnitude * secondMagnitude)))
  return (Math.acos(cosine) * 180) / Math.PI
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const roomRef = useRef<Room | null>(null)
  const localPublishedTracksRef = useRef<Array<{ stop: () => void }>>([])
  const remoteTilesRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const remoteVideoGridRef = useRef<HTMLDivElement | null>(null)
  const textEncoderRef = useRef(new TextEncoder())
  const textDecoderRef = useRef(new TextDecoder())
  const liveProgressSentAtRef = useRef(0)
  const connectedLiveRoleRef = useRef<LiveRole | null>(null)
  const connectedRoomNameRef = useRef('')
  const connectedParticipantNameRef = useRef('')
  const phaseRef = useRef<SquatPhase>('standing')
  const repCountRef = useRef(0)
  const fullSquatPercentRef = useRef<number | null>(null)
  const calibrationProgressRef = useRef(0)
  const isCalibratedRef = useRef(false)
  const smoothedAngleRef = useRef<number | null>(null)
  const smoothedDepthRef = useRef<number | null>(null)
  const smoothedShoulderDropRef = useRef<number | null>(null)
  const standingAngleBaselineRef = useRef(170)
  const standingDepthBaselineRef = useRef(0.52)
  const standingShoulderYBaselineRef = useRef(0.35)
  const calibrationFrameCountRef = useRef(0)
  const downCandidateStartMsRef = useRef<number | null>(null)
  const upCandidateStartMsRef = useRef<number | null>(null)
  const squatStartedAtMsRef = useRef<number | null>(null)

  const [isStarting, setIsStarting] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [repCount, setRepCount] = useState(0)
  const [phase, setPhase] = useState<SquatPhase>('standing')
  const [fullSquatPercent, setFullSquatPercent] = useState<number | null>(null)
  const [isCalibrated, setIsCalibrated] = useState(false)
  const [calibrationProgress, setCalibrationProgress] = useState(0)
  const [liveRoomName, setLiveRoomName] = useState('squat-room')
  const [liveParticipantName, setLiveParticipantName] = useState(
    `squatter-${Math.floor(Math.random() * 9000) + 1000}`,
  )
  const [liveRole, setLiveRole] = useState<LiveRole>('squatter')
  const [isLiveConnecting, setIsLiveConnecting] = useState(false)
  const [isLiveConnected, setIsLiveConnected] = useState(false)
  const [liveParticipantCount, setLiveParticipantCount] = useState(0)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [viewerProgress, setViewerProgress] = useState<LiveProgressPayload | null>(null)
  const [liveReactions, setLiveReactions] = useState<LiveReaction[]>([])

  const isViewerMode = liveRole === 'viewer'

  const activePhase = isViewerMode && viewerProgress ? viewerProgress.phase : phase
  const activeFullSquatPercent = isViewerMode && viewerProgress
    ? viewerProgress.fullSquatPercent
    : fullSquatPercent
  const activeRepCount = isViewerMode && viewerProgress ? viewerProgress.repCount : repCount
  const activeCalibrationProgress = isViewerMode && viewerProgress
    ? viewerProgress.calibrationProgress
    : calibrationProgress
  const activeIsCalibrated = isViewerMode && viewerProgress
    ? viewerProgress.isCalibrated
    : isCalibrated

  const activeFullSquatValue = activeFullSquatPercent ?? 0
  const activeFullSquatHue = Math.round((activeFullSquatValue / 100) * 120)
  const activeSquatGoalProgress = Math.min(100, Math.round((activeRepCount / SQUAT_GOAL) * 100))
  const activeGoalComplete = activeRepCount >= SQUAT_GOAL

  const setTrackingPhase = (nextPhase: SquatPhase) => {
    phaseRef.current = nextPhase
    setPhase(nextPhase)
  }

  useEffect(() => {
    repCountRef.current = repCount
    fullSquatPercentRef.current = fullSquatPercent
    calibrationProgressRef.current = calibrationProgress
    isCalibratedRef.current = isCalibrated
  }, [repCount, fullSquatPercent, calibrationProgress, isCalibrated])

  const sendLiveData = useCallback((payload: LiveDataPayload) => {
    const room = roomRef.current
    if (!room) {
      return
    }

    const encoded = textEncoderRef.current.encode(JSON.stringify(payload))
    void room.localParticipant.publishData(encoded, { reliable: true })
  }, [])

  const publishProgressSnapshot = useCallback(() => {
    if (connectedLiveRoleRef.current !== 'squatter' || !roomRef.current) {
      return
    }

    sendLiveData({
      type: 'progress',
      phase: phaseRef.current,
      fullSquatPercent: fullSquatPercentRef.current,
      repCount: repCountRef.current,
      calibrationProgress: calibrationProgressRef.current,
      isCalibrated: isCalibratedRef.current,
    })
  }, [sendLiveData])

  const releaseSquatterClaim = useCallback(async (roomName: string, participantName: string) => {
    if (!roomName || !participantName) {
      return
    }

    try {
      await fetch('/api/livekit/release-squatter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ roomName, participantName }),
      })
    } catch (err) {
      console.error('Unable to release squatter claim:', err)
    }
  }, [])

  const claimSquatterRole = useCallback(async (roomName: string, participantName: string) => {
    const response = await fetch('/api/livekit/claim-squatter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ roomName, participantName }),
    })

    if (!response.ok) {
      const responseBody = await response.text()
      throw new Error(responseBody || 'Another squatter is already active in this room.')
    }
  }, [])

  const addReaction = useCallback((emoji: string, participantName: string) => {
    const id = `${Date.now()}-${Math.random()}`
    setLiveReactions((previousReactions) => [...previousReactions, { id, emoji, participantName }])

    window.setTimeout(() => {
      setLiveReactions((previousReactions) =>
        previousReactions.filter((reaction) => reaction.id !== id),
      )
    }, 3500)
  }, [])

  const updateLiveParticipantCount = useCallback((room: Room | null) => {
    if (!room) {
      setLiveParticipantCount(0)
      return
    }

    setLiveParticipantCount(room.remoteParticipants.size + 1)
  }, [])

  const removeRemoteTileByKey = useCallback((key: string) => {
    const tileElement = remoteTilesRef.current.get(key)
    if (!tileElement) {
      return
    }

    const mediaElements = tileElement.querySelectorAll('video, audio')
    mediaElements.forEach((mediaElement) => {
      if (mediaElement instanceof HTMLMediaElement) {
        mediaElement.srcObject = null
      }
    })

    tileElement.remove()
    remoteTilesRef.current.delete(key)
  }, [])

  const removeRemoteTilesForParticipant = useCallback((participantSid: string) => {
    const keys = [...remoteTilesRef.current.keys()]
    keys
      .filter((key) => key.startsWith(`${participantSid}:`))
      .forEach((key) => removeRemoteTileByKey(key))
  }, [removeRemoteTileByKey])

  const clearRemoteTiles = useCallback(() => {
    const keys = [...remoteTilesRef.current.keys()]
    keys.forEach((key) => removeRemoteTileByKey(key))
  }, [removeRemoteTileByKey])

  const addRemoteTrackTile = useCallback(
    (track: Track, participantSid: string, participantIdentity: string) => {
      if (track.kind !== Track.Kind.Video) {
        return
      }

      const key = `${participantSid}:${track.sid}`
      if (remoteTilesRef.current.has(key) || !remoteVideoGridRef.current) {
        return
      }

      const tileElement = document.createElement('div')
      tileElement.className = 'remote-tile'

      const labelElement = document.createElement('span')
      labelElement.className = 'remote-label'
      labelElement.textContent = participantIdentity

      const mediaElement = track.attach()
      if (!(mediaElement instanceof HTMLVideoElement)) {
        track.detach(mediaElement)
        return
      }

      mediaElement.className = 'remote-video'
      mediaElement.autoplay = true
      mediaElement.playsInline = true
      mediaElement.muted = true

      tileElement.appendChild(mediaElement)
      tileElement.appendChild(labelElement)
      remoteVideoGridRef.current.appendChild(tileElement)
      remoteTilesRef.current.set(key, tileElement)
    },
    [],
  )

  const disconnectLiveRoom = useCallback(async () => {
    const room = roomRef.current
    const connectedRole = connectedLiveRoleRef.current
    const connectedRoomName = connectedRoomNameRef.current
    const connectedParticipantName = connectedParticipantNameRef.current

    if (!room) {
      if (connectedRole === 'squatter') {
        await releaseSquatterClaim(connectedRoomName, connectedParticipantName)
      }

      connectedLiveRoleRef.current = null
      connectedRoomNameRef.current = ''
      connectedParticipantNameRef.current = ''
      setIsLiveConnected(false)
      setIsLiveConnecting(false)
      setViewerProgress(null)
      setLiveReactions([])
      clearRemoteTiles()
      return
    }

    localPublishedTracksRef.current.forEach((track) => {
      track.stop()
    })
    localPublishedTracksRef.current = []

    room.disconnect()
    roomRef.current = null
    clearRemoteTiles()
    setViewerProgress(null)
    setLiveReactions([])
    setIsLiveConnected(false)
    setIsLiveConnecting(false)
    updateLiveParticipantCount(null)

    if (connectedRole === 'squatter') {
      await releaseSquatterClaim(connectedRoomName, connectedParticipantName)
    }

    connectedLiveRoleRef.current = null
    connectedRoomNameRef.current = ''
    connectedParticipantNameRef.current = ''
  }, [clearRemoteTiles, releaseSquatterClaim, updateLiveParticipantCount])

  const connectLiveRoom = useCallback(async () => {
    if (isLiveConnecting || isLiveConnected) {
      return
    }

    if (liveRole === 'squatter' && !isRunning) {
      setLiveError('Start camera tracking first, then connect as squatter.')
      return
    }

    setLiveError(null)
    setIsLiveConnecting(true)

    try {
      if (liveRole === 'squatter') {
        await claimSquatterRole(liveRoomName, liveParticipantName)
      }

      const response = await fetch('/api/livekit/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          roomName: liveRoomName,
          participantName: liveParticipantName,
          canPublish: liveRole === 'squatter',
        }),
      })

      if (!response.ok) {
        const responseBody = await response.text()
        throw new Error(responseBody || `Failed to create token (${response.status}).`)
      }

      const payload = (await response.json()) as {
        token: string
        url: string
      }

      const room = new Room()

      room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        addRemoteTrackTile(track, participant.sid, participant.identity)
      })

      room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
        removeRemoteTileByKey(`${participant.sid}:${track.sid}`)
      })

      room.on(RoomEvent.ParticipantConnected, () => {
        updateLiveParticipantCount(room)
        publishProgressSnapshot()
      })

      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        removeRemoteTilesForParticipant(participant.sid)
        updateLiveParticipantCount(room)
      })

      room.on(RoomEvent.DataReceived, (payload) => {
        try {
          const raw = textDecoderRef.current.decode(payload)
          const parsed = JSON.parse(raw) as LiveDataPayload

          if (parsed.type === 'progress') {
            setViewerProgress(parsed)
            return
          }

          if (parsed.type === 'reaction') {
            addReaction(parsed.emoji, parsed.participantName)
          }
        } catch (parseError) {
          console.error('Unable to parse LiveKit data payload:', parseError)
        }
      })

      room.on(RoomEvent.Disconnected, () => {
        if (connectedLiveRoleRef.current === 'squatter') {
          void releaseSquatterClaim(
            connectedRoomNameRef.current,
            connectedParticipantNameRef.current,
          )
        }

        clearRemoteTiles()
        roomRef.current = null
        setIsLiveConnected(false)
        setIsLiveConnecting(false)
        setViewerProgress(null)
        setLiveReactions([])
        connectedLiveRoleRef.current = null
        connectedRoomNameRef.current = ''
        connectedParticipantNameRef.current = ''
        updateLiveParticipantCount(null)
      })

      await room.connect(payload.url, payload.token)

      if (liveRole === 'squatter') {
        const localTracks = await createLocalTracks({
          video: true,
          audio: false,
        })

        for (const localTrack of localTracks) {
          await room.localParticipant.publishTrack(localTrack)
        }

        localPublishedTracksRef.current = localTracks.map((track) => ({
          stop: () => track.stop(),
        }))
      } else {
        localPublishedTracksRef.current = []
      }

      roomRef.current = room
      connectedLiveRoleRef.current = liveRole
      connectedRoomNameRef.current = liveRoomName
      connectedParticipantNameRef.current = liveParticipantName
      setIsLiveConnected(true)
      setIsLiveConnecting(false)
      setViewerProgress(null)
      updateLiveParticipantCount(room)
      publishProgressSnapshot()
    } catch (err) {
      console.error('Unable to connect to LiveKit room:', err)
      setLiveError(err instanceof Error ? err.message : 'Unable to connect to LiveKit.')
      if (liveRole === 'squatter') {
        await releaseSquatterClaim(liveRoomName, liveParticipantName)
      }
      await disconnectLiveRoom()
    }
  }, [
    addReaction,
    addRemoteTrackTile,
    clearRemoteTiles,
    claimSquatterRole,
    disconnectLiveRoom,
    isLiveConnected,
    isLiveConnecting,
    isRunning,
    liveParticipantName,
    liveRole,
    liveRoomName,
    removeRemoteTileByKey,
    removeRemoteTilesForParticipant,
    releaseSquatterClaim,
    publishProgressSnapshot,
    updateLiveParticipantCount,
  ])

  const drawSkeleton = (landmarks: Point3D[], videoWidth: number, videoHeight: number) => {
    const canvasElement = canvasRef.current
    if (!canvasElement) {
      return
    }

    const context = canvasElement.getContext('2d')
    if (!context) {
      return
    }

    if (canvasElement.width !== videoWidth || canvasElement.height !== videoHeight) {
      canvasElement.width = videoWidth
      canvasElement.height = videoHeight
    }

    context.clearRect(0, 0, canvasElement.width, canvasElement.height)

    context.lineWidth = 3
    context.strokeStyle = '#7c92f5'
    context.fillStyle = '#8b5ecf'

    for (const [start, end] of SKELETON_CONNECTIONS) {
      const startPoint = landmarks[start]
      const endPoint = landmarks[end]

      if (!startPoint || !endPoint) {
        continue
      }

      context.beginPath()
      context.moveTo(startPoint.x * canvasElement.width, startPoint.y * canvasElement.height)
      context.lineTo(endPoint.x * canvasElement.width, endPoint.y * canvasElement.height)
      context.stroke()
    }

    for (const point of landmarks) {
      context.beginPath()
      context.arc(
        point.x * canvasElement.width,
        point.y * canvasElement.height,
        4,
        0,
        Math.PI * 2,
      )
      context.fill()
    }
  }

  const clearSkeleton = useCallback(() => {
    const canvasElement = canvasRef.current
    if (!canvasElement) {
      return
    }

    const context = canvasElement.getContext('2d')
    context?.clearRect(0, 0, canvasElement.width, canvasElement.height)
  }, [])

  const stopTracking = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    if (videoRef.current) {
      videoRef.current.pause()
      videoRef.current.srcObject = null
    }

    clearSkeleton()

    setIsRunning(false)
  }, [clearSkeleton])

  useEffect(() => {
    return () => {
      stopTracking()
      void disconnectLiveRoom()
      if (landmarkerRef.current) {
        landmarkerRef.current.close()
        landmarkerRef.current = null
      }
    }
  }, [disconnectLiveRoom, stopTracking])

  useEffect(() => {
    if (!isLiveConnected || connectedLiveRoleRef.current !== 'squatter') {
      return
    }

    const now = Date.now()
    if (now - liveProgressSentAtRef.current < 180) {
      return
    }

    liveProgressSentAtRef.current = now

    publishProgressSnapshot()
  }, [
    calibrationProgress,
    fullSquatPercent,
    isCalibrated,
    isLiveConnected,
    phase,
    publishProgressSnapshot,
    repCount,
  ])

  const processFrame = () => {
    const videoElement = videoRef.current
    const poseLandmarker = landmarkerRef.current

    if (!videoElement || !poseLandmarker) {
      return
    }

    if (videoElement.readyState < 2) {
      animationFrameRef.current = requestAnimationFrame(processFrame)
      return
    }

    const results = poseLandmarker.detectForVideo(videoElement, performance.now())

    if (results.landmarks.length > 0) {
      const landmarks = results.landmarks[0]
      drawSkeleton(landmarks, videoElement.videoWidth, videoElement.videoHeight)

      const leftShoulderVisibility = landmarks[LEFT_SHOULDER]?.visibility ?? 0
      const rightShoulderVisibility = landmarks[RIGHT_SHOULDER]?.visibility ?? 0
      const leftHipVisibility = landmarks[LEFT_HIP]?.visibility ?? 0
      const rightHipVisibility = landmarks[RIGHT_HIP]?.visibility ?? 0
      const leftKneeVisibility = landmarks[LEFT_KNEE]?.visibility ?? 0
      const rightKneeVisibility = landmarks[RIGHT_KNEE]?.visibility ?? 0
      const leftAnkleVisibility = landmarks[LEFT_ANKLE]?.visibility ?? 0
      const rightAnkleVisibility = landmarks[RIGHT_ANKLE]?.visibility ?? 0

      const hasReliableLegVisibility =
        leftShoulderVisibility >= LANDMARK_VISIBILITY_THRESHOLD &&
        rightShoulderVisibility >= LANDMARK_VISIBILITY_THRESHOLD &&
        leftHipVisibility >= LANDMARK_VISIBILITY_THRESHOLD &&
        rightHipVisibility >= LANDMARK_VISIBILITY_THRESHOLD &&
        leftKneeVisibility >= LANDMARK_VISIBILITY_THRESHOLD &&
        rightKneeVisibility >= LANDMARK_VISIBILITY_THRESHOLD &&
        leftAnkleVisibility >= LANDMARK_VISIBILITY_THRESHOLD &&
        rightAnkleVisibility >= LANDMARK_VISIBILITY_THRESHOLD

      if (!hasReliableLegVisibility) {
        setFullSquatPercent(null)
        animationFrameRef.current = requestAnimationFrame(processFrame)
        return
      }

      const leftAngle = angleAtJoint(
        landmarks[LEFT_HIP],
        landmarks[LEFT_KNEE],
        landmarks[LEFT_ANKLE],
      )
      const rightAngle = angleAtJoint(
        landmarks[RIGHT_HIP],
        landmarks[RIGHT_KNEE],
        landmarks[RIGHT_ANKLE],
      )

      const rawKneeAngle = (leftAngle + rightAngle) / 2
      const averageShoulderY = (landmarks[LEFT_SHOULDER].y + landmarks[RIGHT_SHOULDER].y) / 2
      const averageHipY = (landmarks[LEFT_HIP].y + landmarks[RIGHT_HIP].y) / 2
      const averageAnkleY = (landmarks[LEFT_ANKLE].y + landmarks[RIGHT_ANKLE].y) / 2
      const torsoToGroundHeight = Math.max(averageAnkleY - averageShoulderY, 0.01)
      const rawHipDepth = (averageHipY - averageShoulderY) / torsoToGroundHeight

      const previousAngle = smoothedAngleRef.current ?? rawKneeAngle
      const previousDepth = smoothedDepthRef.current ?? rawHipDepth
      const smoothedAngle =
        previousAngle + ANGLE_SMOOTHING_ALPHA * (rawKneeAngle - previousAngle)
      const smoothedDepth =
        previousDepth + DEPTH_SMOOTHING_ALPHA * (rawHipDepth - previousDepth)
      const previousShoulderDrop = smoothedShoulderDropRef.current ?? 0
      const rawShoulderDrop =
        (averageShoulderY - standingShoulderYBaselineRef.current) / torsoToGroundHeight
      const smoothedShoulderDrop =
        previousShoulderDrop +
        SHOULDER_DROP_SMOOTHING_ALPHA * (rawShoulderDrop - previousShoulderDrop)

      smoothedAngleRef.current = smoothedAngle
      smoothedDepthRef.current = smoothedDepth
      smoothedShoulderDropRef.current = smoothedShoulderDrop

      if (calibrationFrameCountRef.current < CALIBRATION_FRAME_TARGET) {
        standingAngleBaselineRef.current =
          standingAngleBaselineRef.current * 0.92 + smoothedAngle * 0.08
        standingDepthBaselineRef.current =
          standingDepthBaselineRef.current * 0.92 + smoothedDepth * 0.08
        standingShoulderYBaselineRef.current =
          standingShoulderYBaselineRef.current * 0.92 + averageShoulderY * 0.08
        calibrationFrameCountRef.current += 1

        const progress = Math.round(
          (calibrationFrameCountRef.current / CALIBRATION_FRAME_TARGET) * 100,
        )
        setCalibrationProgress(progress)

        if (calibrationFrameCountRef.current >= CALIBRATION_FRAME_TARGET) {
          setIsCalibrated(true)
        }
      }

      const standingAngleBaseline = standingAngleBaselineRef.current
      const standingDepthBaseline = standingDepthBaselineRef.current

      const hasCalibrationData = calibrationFrameCountRef.current >= CALIBRATION_MIN_FRAMES
      const squatAngleThreshold = hasCalibrationData
        ? Math.max(105, standingAngleBaseline - 30)
        : FALLBACK_SQUAT_ANGLE_THRESHOLD
      const standAngleThreshold = hasCalibrationData
        ? Math.max(squatAngleThreshold + 12, standingAngleBaseline - 12)
        : FALLBACK_STAND_ANGLE_THRESHOLD
      const squatDepthThreshold = standingDepthBaseline + 0.46
      const standDepthThreshold = standingDepthBaseline + 0.04
      const squatShoulderDropThreshold = hasCalibrationData
        ? 0.24
        : FALLBACK_SQUAT_SHOULDER_DROP_THRESHOLD
      const standShoulderDropThreshold = hasCalibrationData
        ? 0.02
        : FALLBACK_STAND_SHOULDER_DROP_THRESHOLD
      const angleDropFromStanding = standingAngleBaseline - smoothedAngle

      const kneeTargetDrop = Math.max(standingAngleBaseline - squatAngleThreshold, 1)
      const kneeDropProgress = Math.min(1, Math.max(0, angleDropFromStanding / kneeTargetDrop))
      const depthProgress = Math.min(
        1,
        Math.max(0, (smoothedDepth - standingDepthBaseline) / (squatDepthThreshold - standingDepthBaseline)),
      )
      const shoulderProgress = Math.min(
        1,
        Math.max(0, smoothedShoulderDrop / squatShoulderDropThreshold),
      )
      const bodyProgress = Math.max(depthProgress, shoulderProgress)
      const overallProgress = Math.round(Math.min(kneeDropProgress, bodyProgress) * 100)
      setFullSquatPercent(overallProgress)

      const kneeSquatCandidate =
        smoothedAngle <= squatAngleThreshold ||
        angleDropFromStanding >= 28
      const bodySquatCandidate =
        smoothedDepth >= squatDepthThreshold ||
        smoothedShoulderDrop >= squatShoulderDropThreshold
      const downCandidate = kneeSquatCandidate && bodySquatCandidate
      const upCandidate =
        smoothedAngle >= standAngleThreshold &&
        smoothedDepth <= standDepthThreshold &&
        smoothedShoulderDrop <= standShoulderDropThreshold

      const now = performance.now()

      if (phaseRef.current === 'standing') {
        if (downCandidate) {
          downCandidateStartMsRef.current ??= now
          const downHeldFor = now - downCandidateStartMsRef.current

          if (downHeldFor >= DOWN_HOLD_MS) {
            setTrackingPhase('squat')
            squatStartedAtMsRef.current = now
            upCandidateStartMsRef.current = null
          }
        } else {
          downCandidateStartMsRef.current = null

          if (smoothedAngle > standingAngleBaseline - 8) {
            standingAngleBaselineRef.current =
              standingAngleBaselineRef.current * 0.98 + smoothedAngle * 0.02
            standingDepthBaselineRef.current =
              standingDepthBaselineRef.current * 0.98 + smoothedDepth * 0.02
            standingShoulderYBaselineRef.current =
              standingShoulderYBaselineRef.current * 0.98 + averageShoulderY * 0.02
          }
        }
      } else {
        if (upCandidate) {
          upCandidateStartMsRef.current ??= now
          const upHeldFor = now - upCandidateStartMsRef.current
          const squatDuration = squatStartedAtMsRef.current ? now - squatStartedAtMsRef.current : 0

          if (upHeldFor >= UP_HOLD_MS && squatDuration >= MIN_REP_DURATION_MS) {
            setTrackingPhase('standing')
            setRepCount((previousCount) => previousCount + 1)
            downCandidateStartMsRef.current = null
            upCandidateStartMsRef.current = null
            squatStartedAtMsRef.current = null
          }
        } else {
          upCandidateStartMsRef.current = null
        }
      }
    } else {
      setFullSquatPercent(null)
      clearSkeleton()
      downCandidateStartMsRef.current = null
      upCandidateStartMsRef.current = null
    }

    animationFrameRef.current = requestAnimationFrame(processFrame)
  }

  const startTracking = async () => {
    setError(null)
    setIsStarting(true)

    try {
      if (!landmarkerRef.current) {
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm',
        )

        landmarkerRef.current = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
          },
          runningMode: 'VIDEO',
          numPoses: 1,
        })
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user',
        },
        audio: false,
      })

      streamRef.current = stream

      if (!videoRef.current) {
        throw new Error('Video element is not available.')
      }

      videoRef.current.srcObject = stream
      await videoRef.current.play()

      setRepCount(0)
      setTrackingPhase('standing')
      setFullSquatPercent(null)
      setIsCalibrated(false)
      setCalibrationProgress(0)

      smoothedAngleRef.current = null
      smoothedDepthRef.current = null
      smoothedShoulderDropRef.current = null
      standingAngleBaselineRef.current = 170
      standingDepthBaselineRef.current = 0.52
      standingShoulderYBaselineRef.current = 0.35
      calibrationFrameCountRef.current = 0
      downCandidateStartMsRef.current = null
      upCandidateStartMsRef.current = null
      squatStartedAtMsRef.current = null

      setIsRunning(true)
      processFrame()
    } catch (err) {
      console.error('Unable to start squat tracking:', err)
      setError(err instanceof Error ? err.message : 'Unable to start camera tracking.')
      stopTracking()
    } finally {
      setIsStarting(false)
    }
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <h1 className="app-title">Squat Detector</h1>
        <p className="app-subtitle">Detect squats live using your webcam and MediaPipe Pose.</p>
      </header>

      <main className="main-content">
        <section className="tracker-section" aria-labelledby="tracker-heading">
          <div className="card">
            <div className="section-header">
              <h2 id="tracker-heading" className="section-title">Pose Tracking</h2>
              <button
                className="action-button"
                onClick={isRunning ? stopTracking : startTracking}
                disabled={isStarting}
                type="button"
              >
                {isStarting ? 'Starting…' : isRunning ? 'Stop Camera' : 'Start Camera'}
              </button>
            </div>

            {error && (
              <div className="error-message" role="alert" aria-live="polite">
                <span>{error}</span>
              </div>
            )}

            <div className="livekit-panel" aria-labelledby="livekit-heading">
              <h3 id="livekit-heading" className="section-title">LiveKit Room</h3>
              <div className="livekit-controls">
                <label className="livekit-field">
                  <span className="stat-label">Room</span>
                  <input
                    className="livekit-input"
                    value={liveRoomName}
                    onChange={(event) => setLiveRoomName(event.target.value)}
                    disabled={isLiveConnected || isLiveConnecting}
                  />
                </label>
                <label className="livekit-field">
                  <span className="stat-label">Name</span>
                  <input
                    className="livekit-input"
                    value={liveParticipantName}
                    onChange={(event) => setLiveParticipantName(event.target.value)}
                    disabled={isLiveConnected || isLiveConnecting}
                  />
                </label>
                <label className="livekit-field">
                  <span className="stat-label">Role</span>
                  <select
                    className="livekit-input"
                    value={liveRole}
                    onChange={(event) => setLiveRole(event.target.value as LiveRole)}
                    disabled={isLiveConnected || isLiveConnecting}
                  >
                    <option value="squatter">Squatter (camera)</option>
                    <option value="viewer">Viewer (no camera)</option>
                  </select>
                </label>
                <button
                  className="action-button"
                  type="button"
                  onClick={isLiveConnected ? () => void disconnectLiveRoom() : () => void connectLiveRoom()}
                  disabled={isLiveConnecting}
                >
                  {isLiveConnecting ? 'Connecting…' : isLiveConnected ? 'Leave Room' : 'Join Room'}
                </button>
              </div>
              {liveError && (
                <div className="error-message" role="alert" aria-live="polite">
                  <span>{liveError}</span>
                </div>
              )}
              <p className="goal-status">
                {isLiveConnected
                  ? `Live: ${liveParticipantCount} participant${liveParticipantCount === 1 ? '' : 's'}`
                  : liveRole === 'squatter'
                    ? 'Join to broadcast your squat feed to others.'
                    : 'Join as viewer without starting your camera.'}
              </p>
              {isLiveConnected && liveRole === 'viewer' && (
                <div className="emoji-row" aria-label="Send reaction emoji">
                  {REACTION_EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      className="emoji-button"
                      type="button"
                      onClick={() => {
                        addReaction(emoji, liveParticipantName)
                        sendLiveData({
                          type: 'reaction',
                          emoji,
                          participantName: liveParticipantName,
                        })
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
              {liveReactions.length > 0 && (
                <div className="reaction-list" aria-live="polite">
                  {liveReactions.map((reaction) => (
                    <span key={reaction.id} className="reaction-chip">
                      {reaction.emoji} {reaction.participantName}
                    </span>
                  ))}
                </div>
              )}
              {!isViewerMode && <div className="remote-grid" ref={remoteVideoGridRef} />}
            </div>

            <div className="camera-wrap">
              {isViewerMode ? (
                <>
                  <div className="remote-grid remote-grid-main" ref={remoteVideoGridRef} />
                  {(!isLiveConnected || liveParticipantCount <= 1) && (
                    <div className="camera-overlay" aria-hidden="true">
                      {isLiveConnected
                        ? 'Waiting for the squatter camera to join this room.'
                        : 'Join the room to watch the squatter in the main feed.'}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <video ref={videoRef} className="camera-video" autoPlay muted playsInline />
                  <canvas ref={canvasRef} className="skeleton-canvas" aria-hidden="true" />
                  {!isRunning && (
                    <div className="camera-overlay" aria-hidden="true">
                      Click “Start Camera” to begin squat tracking.
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="stats-grid" aria-live="polite">
              <div className="stat-card">
                <span className="stat-label">Status</span>
                <span className={`stat-value ${activePhase === 'squat' ? 'is-squat' : 'is-standing'}`}>
                  {activePhase === 'squat' ? 'In Squat' : 'Standing'}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Full Squat</span>
                <span className="stat-value">
                  {activeFullSquatPercent !== null ? `${activeFullSquatPercent}%` : '--'}
                </span>
                <div className="progress-track" aria-hidden="true">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${activeFullSquatValue}%`,
                      backgroundColor: `hsl(${activeFullSquatHue} 85% 45%)`,
                    }}
                  />
                </div>
              </div>
              <div className="stat-card">
                <span className="stat-label">Squat Reps</span>
                <span className="stat-value">
                  {Math.min(activeRepCount, SQUAT_GOAL)}/{SQUAT_GOAL}
                </span>
                <div className="progress-track" aria-hidden="true">
                  <div className="progress-fill" style={{ width: `${activeSquatGoalProgress}%` }} />
                </div>
                <span className="goal-status">
                  {activeGoalComplete ? 'Finished ✅' : `${SQUAT_GOAL - activeRepCount} to finish`}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Calibration</span>
                <span className="stat-value">
                  {activeIsCalibrated ? 'Ready' : `${activeCalibrationProgress}%`}
                </span>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
