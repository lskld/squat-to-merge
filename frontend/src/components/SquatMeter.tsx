import { useEffect, useRef } from 'react'

type SquatMeterProps = {
  /** 0-100 how deep the current squat is */
  fullSquatPercent: number | null
  /** Total reps completed */
  repCount: number
  /** Goal to reach */
  goal: number
  /** Current phase */
  phase: 'standing' | 'squat'
  /** Whether calibration is done */
  isCalibrated: boolean
  /** Calibration progress 0-100 (null when not available, e.g. viewer) */
  calibrationProgress?: number | null
  /** Override label when goal is complete */
  goalComplete?: boolean
}

const RING_SIZE = 180
const STROKE_WIDTH = 14
const RADIUS = (RING_SIZE - STROKE_WIDTH) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export default function SquatMeter({
  fullSquatPercent,
  repCount,
  goal,
  phase,
  isCalibrated,
  calibrationProgress,
  goalComplete: goalCompleteProp,
}: SquatMeterProps) {
  const prevCountRef = useRef(repCount)
  const popRef = useRef<HTMLDivElement>(null)

  // Trigger pop animation on rep increment
  useEffect(() => {
    if (repCount > prevCountRef.current && popRef.current) {
      popRef.current.classList.remove('squat-meter-pop')
      // Force reflow
      void popRef.current.offsetWidth
      popRef.current.classList.add('squat-meter-pop')
    }
    prevCountRef.current = repCount
  }, [repCount])

  const percent = fullSquatPercent ?? 0
  const offset = CIRCUMFERENCE - (percent / 100) * CIRCUMFERENCE
  const hue = Math.round((percent / 100) * 120) // red(0) → green(120)
  const ringColor = `hsl(${hue} 85% 50%)`
  const glowColor = `hsla(${hue} 90% 55% / 0.5)`
  const goalDone = goalCompleteProp ?? repCount >= goal
  const goalProgress = Math.min(1, repCount / goal)

  return (
    <div className="squat-meter" ref={popRef}>
      <div className="squat-meter-ring-wrap">
        {/* Glow layer */}
        <div
          className="squat-meter-glow"
          style={{
            background: `radial-gradient(circle, ${glowColor} 0%, transparent 70%)`,
            opacity: percent > 10 ? 0.7 + (percent / 100) * 0.3 : 0,
          }}
        />

        <svg
          className="squat-meter-svg"
          width={RING_SIZE}
          height={RING_SIZE}
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        >
          {/* Background track */}
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="#21262d"
            strokeWidth={STROKE_WIDTH}
          />
          {/* Animated fill ring */}
          <circle
            className="squat-meter-ring"
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={ringColor}
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
            style={{
              filter: percent > 50 ? `drop-shadow(0 0 6px ${glowColor})` : 'none',
            }}
          />
        </svg>

        {/* Center content */}
        <div className="squat-meter-center">
          <span className="squat-meter-percent">
            {fullSquatPercent !== null ? `${fullSquatPercent}%` : '--'}
          </span>
          <span className="squat-meter-label">
            {phase === 'squat' ? 'SQUATTING' : isCalibrated ? 'READY' : 'CALIBRATING'}
          </span>
        </div>
      </div>

      {/* Rep counter strip below the ring */}
      <div className="squat-meter-reps">
        <div className="squat-meter-rep-bar-track">
          <div
            className={`squat-meter-rep-bar-fill ${goalDone ? 'is-done' : ''}`}
            style={{ width: `${goalProgress * 100}%` }}
          />
        </div>
        <span className="squat-meter-rep-text">
          {goalDone ? (
            <span className="squat-meter-done">PR MERGED</span>
          ) : (
            <>
              <strong>{Math.min(repCount, goal)}</strong>
              <span className="squat-meter-rep-dim">/{goal} squats</span>
            </>
          )}
        </span>
      </div>

      {/* Status pill */}
      <div className="squat-meter-pills">
        <span className={`squat-meter-pill ${phase === 'squat' ? 'is-squat' : 'is-standing'}`}>
          {goalDone
            ? 'Done'
            : phase === 'squat'
              ? 'In Squat'
              : 'Standing'}
        </span>
      </div>
    </div>
  )
}
