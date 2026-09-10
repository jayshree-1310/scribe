/**
 * File uploads.
 *
 * One call: send the bytes, get back a URL to store on whatever row
 * references it. The two steps are deliberately separate — the upload does not
 * know what it is for — so the caller follows it with the write that saves the
 * URL (`updateStory({ coverUrl })` for a story cover, `addMultimedia` for a
 * chapter attachment).
 */

import { request } from '../lib/api-client'
import { readerHeaders } from './stories-api'

/**
 * What an upload is for. `cover` takes images only; `media` is a chapter
 * attachment and takes audio and video as well, under a much larger cap.
 */
export type UploadKind = 'cover' | 'media'

export interface StoredUpload {
  url: string
  contentType: string
  bytes: number
  /**
   * What the API decided the bytes are, from their signature. Passed straight
   * to `addMultimedia` — an attachment's type is not the caller's guess from
   * the file name.
   */
  multimediaType: 'IMAGE' | 'AUDIO' | 'VIDEO'
}

/**
 * Largest image the API accepts, checked here so an obviously oversized file
 * costs no upload. The API enforces the same ceiling; this is only courtesy.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** The same courtesy check for audio and video, which get their own cap. */
export const MAX_MEDIA_BYTES = 128 * 1024 * 1024

export const ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

/**
 * The containers the API sniffs for. Browsers are inconsistent about what they
 * report for these — Firefox calls an `.m4a` `audio/mp4` and Chrome sometimes
 * says nothing at all — so this list picks the file dialog's filter and is
 * *not* used to refuse anything. The signature check on the API is what
 * decides, and it never sees this value.
 */
export const ACCEPTED_MEDIA_TYPES = [
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'video/mp4',
  'video/webm',
  'video/ogg',
]

/**
 * Sends the file as the request body rather than a multipart form: one field
 * needs no envelope, and the API sniffs the bytes regardless of what the
 * browser calls them — so a rename cannot smuggle anything past it.
 */
export function uploadFile(
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

/** An image for a story cover. */
export function uploadImage(file: File): Promise<StoredUpload> {
  return uploadFile(file, 'cover')
}

/** An image, audio or video file to attach to a chapter. */
export function uploadMedia(file: File): Promise<StoredUpload> {
  return uploadFile(file, 'media')
}
