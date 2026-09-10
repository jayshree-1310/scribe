/**
 * File uploads.
 *
 * One call: send the bytes, get back a URL to store on whatever row
 * references it. The two steps are deliberately separate — the upload does not
 * know what it is for — so the caller follows it with the write that saves the
 * URL (`updateStory({ coverUrl })` for a story cover).
 */

import { request } from '../lib/api-client'
import { readerHeaders } from './stories-api'

/** What an upload is for. Audio and video for chapter media are still to come. */
export type UploadKind = 'cover'

export interface StoredUpload {
  url: string
  contentType: string
  bytes: number
}

/**
 * Largest image the API accepts, checked here so an obviously oversized file
 * costs no upload. The API enforces the same ceiling; this is only courtesy.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export const ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

/**
 * Sends the file as the request body rather than a multipart form: one field
 * needs no envelope, and the API sniffs the bytes regardless of what the
 * browser calls them — so a rename cannot smuggle anything past it.
 */
export function uploadImage(
  file: File,
  kind: UploadKind = 'cover',
): Promise<StoredUpload> {
  return request<StoredUpload>('/uploads', {
    method: 'POST',
    headers: readerHeaders(),
    query: { kind },
    body: file,
  })
}
