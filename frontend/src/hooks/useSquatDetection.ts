import { useCallback, useEffect, useRef, useState } from 'react'
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'

export type SquatPhase = 'standing' | 'squat'

type Point3D = {
  x: number
  y: number
  z: number
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

const SKELETON_CONNECTIONS: Array<[number, number]> = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
  [24, 26], [26, 28],
]

const angleAtJoint = (first: Point3D, joint: Point3D, third: Point3D) => {
  const v1x = first.x - joint.x
  const v1y = first.y - joint.y
  const v1z = first.z - joint.z
  const v2x = third.x - joint.x
  const v2y = third.y - joint.y
  const v2z = third.z - joint.z

  const dot = v1x * v2x + v1y * v2y + v1z * v2z
  const m1 = Math.sqrt(v1x * v1x + v1y * v1y + v1z * v1z)
  const m2 = Math.sqrt(v2x * v2x + v2y * v2y + v2z * v2z)

  if (!m1 || !m2) return 180
  const cosine = Math.max(-1, Math.min(1, dot / (m1 * m2)))
  return (Math.acos(cosine) * 180) / Math.PI
}

export interface SquatDetectionResult {
  repCount: number
  phase: SquatPhase
  fullSquatPercent: number | null
  isCalibrated: boolean
  calibrationProgress: number
  isRunning: boolean
  isStarting: boolean
  error: string | null
  stream: MediaStream | null
  startTracking: () => Promise<void>
  stopTracking: () => void
}

export function useSquatDetection(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
): SquatDetectionResult {
  const streamRef = useRef<MediaStream | null>(null)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const phaseRef = useRef<SquatPhase>('standing')
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
  const [stream, setStream] = useState<MediaStream | null>(null)

  const setTrackingPhase = (next: SquatPhase) => {
    phaseRef.current = next
    setPhase(next)
  }

  const drawSkeleton = (landmarks: Point3D[], vw: number, vh: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw
      canvas.height = vh
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.lineWidth = 3
    ctx.strokeStyle = '#7c92f5'
    ctx.fillStyle = '#8b5ecf'
    for (const [s, e] of SKELETON_CONNECTIONS) {
      const sp = landmarks[s], ep = landmarks[e]
      if (!sp || !ep) continue
      ctx.beginPath()
      ctx.moveTo(sp.x * canvas.width, sp.y * canvas.height)
      ctx.lineTo(ep.x * canvas.width, ep.y * canvas.height)
      ctx.stroke()
    }
    for (const p of landmarks) {
      ctx.beginPath()
      ctx.arc(p.x * canvas.width, p.y * canvas.height, 4, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  const clearSkeleton = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    ctx?.clearRect(0, 0, canvas.width, canvas.height)
  }, [canvasRef])

  const stopTracking = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.pause()
      videoRef.current.srcObject = null
    }
    clearSkeleton()
    setIsRunning(false)
    setStream(null)
  }, [clearSkeleton, videoRef])

  useEffect(() => {
    return () => {
      stopTracking()
      if (landmarkerRef.current) {
        landmarkerRef.current.close()
        landmarkerRef.current = null
      }
    }
  }, [stopTracking])

  const processFrame = () => {
    const video = videoRef.current
    const landmarker = landmarkerRef.current
    if (!video || !landmarker) return
    if (video.readyState < 2) {
      animationFrameRef.current = requestAnimationFrame(processFrame)
      return
    }

    const results = landmarker.detectForVideo(video, performance.now())
    if (results.landmarks.length > 0) {
      const lm = results.landmarks[0]
      drawSkeleton(lm, video.videoWidth, video.videoHeight)

      const vis = (i: number) => lm[i]?.visibility ?? 0
      const hasVis =
        vis(LEFT_SHOULDER) >= LANDMARK_VISIBILITY_THRESHOLD &&
        vis(RIGHT_SHOULDER) >= LANDMARK_VISIBILITY_THRESHOLD &&
        vis(LEFT_HIP) >= LANDMARK_VISIBILITY_THRESHOLD &&
        vis(RIGHT_HIP) >= LANDMARK_VISIBILITY_THRESHOLD &&
        vis(LEFT_KNEE) >= LANDMARK_VISIBILITY_THRESHOLD &&
        vis(RIGHT_KNEE) >= LANDMARK_VISIBILITY_THRESHOLD &&
        vis(LEFT_ANKLE) >= LANDMARK_VISIBILITY_THRESHOLD &&
        vis(RIGHT_ANKLE) >= LANDMARK_VISIBILITY_THRESHOLD

      if (!hasVis) {
        setFullSquatPercent(null)
        animationFrameRef.current = requestAnimationFrame(processFrame)
        return
      }

      const leftA = angleAtJoint(lm[LEFT_HIP], lm[LEFT_KNEE], lm[LEFT_ANKLE])
      const rightA = angleAtJoint(lm[RIGHT_HIP], lm[RIGHT_KNEE], lm[RIGHT_ANKLE])
      const rawKnee = (leftA + rightA) / 2

      const avgShY = (lm[LEFT_SHOULDER].y + lm[RIGHT_SHOULDER].y) / 2
      const avgHipY = (lm[LEFT_HIP].y + lm[RIGHT_HIP].y) / 2
      const avgAnkY = (lm[LEFT_ANKLE].y + lm[RIGHT_ANKLE].y) / 2
      const tgh = Math.max(avgAnkY - avgShY, 0.01)
      const rawDepth = (avgHipY - avgShY) / tgh

      const prevA = smoothedAngleRef.current ?? rawKnee
      const prevD = smoothedDepthRef.current ?? rawDepth
      const sAngle = prevA + ANGLE_SMOOTHING_ALPHA * (rawKnee - prevA)
      const sDepth = prevD + DEPTH_SMOOTHING_ALPHA * (rawDepth - prevD)
      const prevSD = smoothedShoulderDropRef.current ?? 0
      const rawSD = (avgShY - standingShoulderYBaselineRef.current) / tgh
      const sSD = prevSD + SHOULDER_DROP_SMOOTHING_ALPHA * (rawSD - prevSD)

      smoothedAngleRef.current = sAngle
      smoothedDepthRef.current = sDepth
      smoothedShoulderDropRef.current = sSD

      if (calibrationFrameCountRef.current < CALIBRATION_FRAME_TARGET) {
        standingAngleBaselineRef.current = standingAngleBaselineRef.current * 0.92 + sAngle * 0.08
        standingDepthBaselineRef.current = standingDepthBaselineRef.current * 0.92 + sDepth * 0.08
        standingShoulderYBaselineRef.current = standingShoulderYBaselineRef.current * 0.92 + avgShY * 0.08
        calibrationFrameCountRef.current += 1
        const p = Math.round((calibrationFrameCountRef.current / CALIBRATION_FRAME_TARGET) * 100)
        setCalibrationProgress(p)
        if (calibrationFrameCountRef.current >= CALIBRATION_FRAME_TARGET) setIsCalibrated(true)
      }

      const sab = standingAngleBaselineRef.current
      const sdb = standingDepthBaselineRef.current
      const hasCal = calibrationFrameCountRef.current >= CALIBRATION_MIN_FRAMES

      const sqAngle = hasCal ? Math.max(105, sab - 30) : FALLBACK_SQUAT_ANGLE_THRESHOLD
      const stAngle = hasCal ? Math.max(sqAngle + 12, sab - 12) : FALLBACK_STAND_ANGLE_THRESHOLD
      const sqDepth = sdb + 0.46
      const stDepth = sdb + 0.04
      const sqSD = hasCal ? 0.24 : FALLBACK_SQUAT_SHOULDER_DROP_THRESHOLD
      const stSD = hasCal ? 0.02 : FALLBACK_STAND_SHOULDER_DROP_THRESHOLD

      const aDrop = sab - sAngle
      const kTarget = Math.max(sab - sqAngle, 1)
      const kProg = Math.min(1, Math.max(0, aDrop / kTarget))
      const dProg = Math.min(1, Math.max(0, (sDepth - sdb) / (sqDepth - sdb)))
      const sProg = Math.min(1, Math.max(0, sSD / sqSD))
      const bProg = Math.max(dProg, sProg)
      setFullSquatPercent(Math.round(Math.min(kProg, bProg) * 100))

      const kneeDown = sAngle <= sqAngle || aDrop >= 28
      const bodyDown = sDepth >= sqDepth || sSD >= sqSD
      const down = kneeDown && bodyDown
      const up = sAngle >= stAngle && sDepth <= stDepth && sSD <= stSD
      const now = performance.now()

      if (phaseRef.current === 'standing') {
        if (down) {
          downCandidateStartMsRef.current ??= now
          if (now - downCandidateStartMsRef.current >= DOWN_HOLD_MS) {
            setTrackingPhase('squat')
            squatStartedAtMsRef.current = now
            upCandidateStartMsRef.current = null
          }
        } else {
          downCandidateStartMsRef.current = null
          if (sAngle > sab - 8) {
            standingAngleBaselineRef.current = sab * 0.98 + sAngle * 0.02
            standingDepthBaselineRef.current = sdb * 0.98 + sDepth * 0.02
            standingShoulderYBaselineRef.current =
              standingShoulderYBaselineRef.current * 0.98 + avgShY * 0.02
          }
        }
      } else {
        if (up) {
          upCandidateStartMsRef.current ??= now
          const held = now - upCandidateStartMsRef.current
          const dur = squatStartedAtMsRef.current ? now - squatStartedAtMsRef.current : 0
          if (held >= UP_HOLD_MS && dur >= MIN_REP_DURATION_MS) {
            setTrackingPhase('standing')
            setRepCount((c) => c + 1)
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

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      })

      streamRef.current = mediaStream
      setStream(mediaStream)

      if (!videoRef.current) throw new Error('Video element is not available.')
      videoRef.current.srcObject = mediaStream
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

  return {
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
  }
}
