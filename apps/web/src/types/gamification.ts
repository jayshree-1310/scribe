/**
 * Badge and level types.
 *
 * These mirror the API responses in `apps/api/src/services/gamification.ts`
 * exactly, the same way `types/challenges.ts` mirrors the challenges service.
 *
 * What the mock invented and nothing counts, so it is absent from the
 * catalogue the API serves: "read 500 minutes in a week" (no reading duration
 * is recorded), "25 helpful reviews" (there is no helpfulness vote), "read
 * after midnight 30 times" (no reader-local clock is stored) and "post 10
 * weeks running" (club posts are counted, the weeks are not). The service
 * header lists what replaced each.
 *
 * A badge carries no `metric` or `threshold`. Both are real fields on the
 * server's `BadgeDefinition` and neither is sent: `progress` is the answer
 * they exist to compute, and shipping the rule as well would invite a second
 * implementation of it here.
 */

export type BadgeTier = 'bronze' | 'silver' | 'gold'

export type BadgeCategory = 'reading' | 'writing' | 'community'

export interface Badge {
  /** Stable key. What `UserBadge.code` stores and what the UI keys on. */
  code: string
  name: string
  /** Shown once earned. */
  description: string
  /** Shown while locked: what to do to get it. */
  criteria: string
  /** Icon key resolved by the `Icon` component. */
  icon: string
  tier: BadgeTier
  category: BadgeCategory
}

export interface BadgeProgress {
  badge: Badge
  earned: boolean
  earnedAt: string | null
  /** 0-1 toward the threshold; 1 once earned. */
  progress: number
}

export interface LevelProgress {
  level: number
  /** The metric the level was derived from: chapters read, or words written. */
  value: number
  /** Where the next level begins, or null at the top of the ladder. */
  next: number | null
  /** 0-1 from the current level's floor to `next`; 1 at the top. */
  progress: number
}

export interface BadgeCollection {
  badges: BadgeProgress[]
  levels: { reader: LevelProgress; author: LevelProgress }
  /**
   * Awarded by the evaluation this request ran. Empty whenever an earlier
   * event already awarded them, so it is not on its own a reliable "what is
   * new" -- which is why announcing a badge is the notification system's job
   * and not this field's. Kept because the API sends it.
   */
  newlyEarned: Badge[]
}
