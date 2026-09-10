import { useEffect, useState } from 'react'

/**
 * A `blob:` URL for a file, revoked when the file changes or the component
 * goes away — object URLs are a document-lifetime leak until revoked.
 *
 * The URL is created inside the effect rather than during render on purpose.
 * A URL made during render (or in a `useState` initialiser) is not re-made
 * when an effect cleanup revokes it, so under StrictMode's mount–unmount–mount
 * the surviving state points at a URL that has already been revoked and the
 * image fails to load. Owning both halves in the effect keeps the handle and
 * the resource in step.
 *
 * The URL is returned only for the file it was made from, so a handle left
 * over from a previous file is never handed back while its replacement is
 * still being created. Callers get null on the first render and while there is
 * no file, and render the image only once there is a URL for it.
 */
export function useObjectUrl(file: Blob | null): string | null {
  const [made, setMade] = useState<{ file: Blob; url: string } | null>(null)

  useEffect(() => {
    if (!file) return

    const url = URL.createObjectURL(file)
    // The effect allocates an external resource, so its handle can only be
    // published from here; creating it during render would leave it revoked.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMade({ file, url })

    return () => URL.revokeObjectURL(url)
  }, [file])

  return made?.file === file ? made.url : null
}
