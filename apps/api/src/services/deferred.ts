/**
 * Settling every fire-and-forget write the app has issued, in the one order
 * that is correct.
 *
 * **Why this module exists.** Three services defer writes past the request that
 * caused them -- `services/analytics.ts`, `services/gamification.ts` and
 * `services/notifications.ts` -- and three callers have to settle them: a
 * shutdown that must not drop a write already issued, `deleteAccount`, whose
 * transaction would otherwise race a row naming the account it is deleting,
 * and the test harness, which asserts against rows that had not landed yet.
 *
 * The order is load-bearing and was, until this file, enforced only by a
 * comment repeated at each call site. A badge award is itself fire-and-forget
 * and calls `notify` as it lands, so a notification can be issued *after*
 * `flushBadges()` returns by work that flush had not settled. Draining the two
 * in parallel therefore loses the badge notification about one time in ten --
 * the worst kind of flake: rare, real, and about the one write nobody is
 * watching.
 *
 * Every caller now calls `drainDeferredWrites()` and there is no order left to
 * get wrong. That is the whole point: the individual flushes are still
 * exported by their own services because each one's *seam* belongs there, but
 * nothing outside this file should be calling more than one of them.
 *
 * **Adding a fourth deferred writer.** Put its flush in the right band below.
 * A writer that can issue work for another band drains before that band; a
 * writer nothing else feeds drains in the first.
 */

import { flushAnalytics } from "./analytics.js";
import { flushBadges } from "./gamification.js";
import { flushNotifications } from "./notifications.js";

export async function drainDeferredWrites(): Promise<void> {
  /**
   * First band: writers that can *cause* further deferred work. Analytics
   * causes none and is here only because it can settle alongside for free.
   */
  await Promise.all([flushBadges(), flushAnalytics()]);

  /**
   * Second band: writers the first band feeds. A badge landing above issues a
   * notification, so this cannot start until that has settled -- and because
   * `flushNotifications` loops until its pending set is empty, work issued
   * while it runs is caught too.
   */
  await flushNotifications();
}
