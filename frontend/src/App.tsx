import { useCallback, useEffect, useRef, useState } from 'react'
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import './App.css'

type SquatPhase = 'standing' | 'squat'

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
const SQUAT_GOAL = 10

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

  const fullSquatValue = fullSquatPercent ?? 0
  const fullSquatHue = Math.round((fullSquatValue / 100) * 120)
  const squatGoalProgress = Math.min(100, Math.round((repCount / SQUAT_GOAL) * 100))
  const goalComplete = repCount >= SQUAT_GOAL

  const setTrackingPhase = (nextPhase: SquatPhase) => {
    phaseRef.current = nextPhase
    setPhase(nextPhase)
  }

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
      if (landmarkerRef.current) {
        landmarkerRef.current.close()
        landmarkerRef.current = null
      }
    }
  }, [stopTracking])

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

            <div className="camera-wrap">
              <video ref={videoRef} className="camera-video" autoPlay muted playsInline />
              <canvas ref={canvasRef} className="skeleton-canvas" aria-hidden="true" />
              {!isRunning && (
                <div className="camera-overlay" aria-hidden="true">
                  Click “Start Camera” to begin squat tracking.
                </div>
              )}
            </div>

            <div className="stats-grid" aria-live="polite">
              <div className="stat-card">
                <span className="stat-label">Status</span>
                <span className={`stat-value ${phase === 'squat' ? 'is-squat' : 'is-standing'}`}>
                  {phase === 'squat' ? 'In Squat' : 'Standing'}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Full Squat</span>
                <span className="stat-value">
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
              <div className="stat-card">
                <span className="stat-label">Squat Reps</span>
                <span className="stat-value">
                  {Math.min(repCount, SQUAT_GOAL)}/{SQUAT_GOAL}
                </span>
                <div className="progress-track" aria-hidden="true">
                  <div className="progress-fill" style={{ width: `${squatGoalProgress}%` }} />
                </div>
                <span className="goal-status">
                  {goalComplete ? 'Finished ✅' : `${SQUAT_GOAL - repCount} to finish`}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Calibration</span>
                <span className="stat-value">
                  {isCalibrated ? 'Ready' : `${calibrationProgress}%`}
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
