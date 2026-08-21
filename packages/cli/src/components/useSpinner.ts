import { useEffect, useState } from "react"

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** Braille spinner frame, or a static dot when nothing is in flight. */
export function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [active])

  return active ? FRAMES[frame]! : "·"
}
