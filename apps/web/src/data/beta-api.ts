/**
 * Beta readers: the author's invite link and readers, joining through a link,
 * and private feedback. Everything here needs a session. Reading what a beta
 * reader joined goes through the ordinary story endpoints (`stories-api.ts`).
 */

import { request } from '../lib/api-client'
import type { BetaFeedback, BetaInvite, BetaLink, BetaOverview } from '../types/beta'

const enc = encodeURIComponent

/* Author ----------------------------------------------------------------- */

export async function getOverview(storyId: string): Promise<BetaOverview> {
  return request<BetaOverview>(`/beta/stories/${enc(storyId)}`)
}

/** Makes the story's link, or returns the one it already has. */
export async function createLink(storyId: string): Promise<BetaLink> {
  const { link } = await request<{ link: BetaLink }>(
    `/beta/stories/${enc(storyId)}/link`,
    { method: 'POST' },
  )
  return link
}

/** Turns the link off and removes every reader who joined through it. */
export async function revokeLink(storyId: string): Promise<void> {
  await request<void>(`/beta/stories/${enc(storyId)}/link`, { method: 'DELETE' })
}

export async function removeReader(storyId: string, userId: string): Promise<void> {
  await request<void>(`/beta/stories/${enc(storyId)}/readers/${enc(userId)}`, {
    method: 'DELETE',
  })
}

/* Readers ---------------------------------------------------------------- */

export async function previewInvite(token: string): Promise<BetaInvite> {
  return request<BetaInvite>(`/beta/invites/${enc(token)}`)
}

/** Joins, and returns the story's slug to open. */
export async function joinBeta(token: string): Promise<string> {
  const { slug } = await request<{ slug: string }>(`/beta/invites/${enc(token)}/join`, {
    method: 'POST',
  })
  return slug
}

export async function leaveBeta(storyId: string): Promise<void> {
  await request<void>(`/beta/stories/${enc(storyId)}/membership`, { method: 'DELETE' })
}

/* Feedback --------------------------------------------------------------- */

/** All of a story's feedback for its author; the caller's own for anybody else. */
export async function listFeedback(storyKey: string): Promise<BetaFeedback[]> {
  const { feedback } = await request<{ feedback: BetaFeedback[] }>(
    `/beta/stories/${enc(storyKey)}/feedback`,
  )
  return feedback
}

export async function createFeedback(input: {
  chapterId: string
  body: string
  start?: number
  end?: number
}): Promise<BetaFeedback> {
  const { feedback } = await request<{ feedback: BetaFeedback }>('/beta/feedback', {
    method: 'POST',
    body: input,
  })
  return feedback
}

export async function updateFeedback(id: string, body: string): Promise<BetaFeedback> {
  const { feedback } = await request<{ feedback: BetaFeedback }>(
    `/beta/feedback/${enc(id)}`,
    { method: 'PATCH', body: { body } },
  )
  return feedback
}

export async function deleteFeedback(id: string): Promise<void> {
  await request<void>(`/beta/feedback/${enc(id)}`, { method: 'DELETE' })
}
