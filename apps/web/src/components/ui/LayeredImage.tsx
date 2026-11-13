import { useState } from 'react'

/**
 * An image laid over generated art (a cover, a monogram), which takes itself
 * away if it fails to load.
 *
 * The art underneath is the fallback by design, but a failed `<img>` still
 * draws the browser's broken-image icon on top of it -- a deleted upload, a
 * paused bucket, a dead remote URL. Remembered per `src`, so a new URL gets
 * its own chance.
 */
export function LayeredImage({
  src,
  className,
  loading,
}: {
  src: string
  className: string
  loading?: 'lazy' | 'eager'
}) {
  const [failed, setFailed] = useState<string | null>(null)

  if (failed === src) return null

  return (
    <img
      className={className}
      src={src}
      alt=""
      loading={loading}
      onError={() => setFailed(src)}
    />
  )
}
