import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/**
 * Tracks an element's width so SVG charts can render at real pixel sizes —
 * keeping stroke widths and type crisp instead of scaling a fixed viewBox.
 */
export function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const node = ref.current
    if (!node) return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return [ref, width]
}
