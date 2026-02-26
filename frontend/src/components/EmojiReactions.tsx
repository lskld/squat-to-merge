import { useCallback, useEffect, useRef, useState } from 'react'
import type { Room, RemoteParticipant } from 'livekit-client'

const EMOJI_OPTIONS = ['🔥', '💪', '👏', '🎉', '😂', '❤️', '🏋️', '⚡']

type FloatingEmoji = {
  id: number
  emoji: string
  x: number        // random horizontal position (%)
  delay: number     // animation delay (ms)
  duration: number  // animation duration (ms)
  scale: number     // random scale factor
  drift: number     // horizontal drift direction (-1 or 1) * amount
}

type EmojiMessage = {
  type: 'emoji_reaction'
  emoji: string
  sender: string
}

let nextEmojiId = 0

export default function EmojiReactions({ room }: { room: Room | null }) {
  const [floatingEmojis, setFloatingEmojis] = useState<FloatingEmoji[]>([])
  const containerRef = useRef<HTMLDivElement>(null)

  // Throttle: max 1 send per 300ms
  const lastSentRef = useRef(0)

  const spawnEmoji = useCallback((emoji: string) => {
    const id = nextEmojiId++
    const floating: FloatingEmoji = {
      id,
      emoji,
      x: 5 + Math.random() * 90,                // 5% to 95%
      delay: Math.random() * 100,                 // 0-100ms stagger
      duration: 2200 + Math.random() * 1200,      // 2.2-3.4s
      scale: 0.8 + Math.random() * 0.7,           // 0.8-1.5x
      drift: (Math.random() - 0.5) * 60,          // -30 to +30 px
    }
    setFloatingEmojis((prev) => [...prev, floating])

    // Auto-remove after animation completes
    setTimeout(() => {
      setFloatingEmojis((prev) => prev.filter((e) => e.id !== id))
    }, floating.duration + floating.delay + 200)
  }, [])

  const sendReaction = useCallback(
    (emoji: string) => {
      const now = Date.now()
      if (now - lastSentRef.current < 300) return
      lastSentRef.current = now

      // Spawn locally
      spawnEmoji(emoji)

      // Broadcast via LiveKit data channel
      if (room?.localParticipant) {
        const msg: EmojiMessage = {
          type: 'emoji_reaction',
          emoji,
          sender: room.localParticipant.identity,
        }
        const encoded = new TextEncoder().encode(JSON.stringify(msg))
        room.localParticipant.publishData(encoded, { reliable: false }).catch(() => {})
      }
    },
    [room, spawnEmoji],
  )

  // Listen for incoming emoji reactions from others
  useEffect(() => {
    if (!room) return

    const onData = (payload: Uint8Array, participant: RemoteParticipant | undefined) => {
      // Skip our own messages
      if (participant?.identity === room.localParticipant.identity) return
      try {
        const data = JSON.parse(new TextDecoder().decode(payload))
        if (data.type === 'emoji_reaction' && typeof data.emoji === 'string') {
          spawnEmoji(data.emoji)
        }
      } catch {
        // ignore non-json or unrelated messages
      }
    }

    room.on('dataReceived', onData)
    return () => {
      room.off('dataReceived', onData)
    }
  }, [room, spawnEmoji])

  return (
    <>
      {/* Floating emoji overlay */}
      <div ref={containerRef} className="emoji-float-container" aria-hidden="true">
        {floatingEmojis.map((fe) => (
          <span
            key={fe.id}
            className="emoji-float"
            style={{
              left: `${fe.x}%`,
              animationDelay: `${fe.delay}ms`,
              animationDuration: `${fe.duration}ms`,
              fontSize: `${fe.scale * 2}rem`,
              ['--drift' as string]: `${fe.drift}px`,
            }}
          >
            {fe.emoji}
          </span>
        ))}
      </div>

      {/* Emoji picker bar */}
      <div className="emoji-picker-bar">
        {EMOJI_OPTIONS.map((emoji) => (
          <button
            key={emoji}
            className="emoji-picker-btn"
            onClick={() => sendReaction(emoji)}
            type="button"
            aria-label={`React with ${emoji}`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </>
  )
}
