/**
 * Deletes AI usage rows past their retention window (`AI_USAGE_RETENTION_DAYS`,
 * default 90). See `pruneUsage` in `services/ai/usage.ts` and
 * `docs/ai-security.md` for why the window is what it is.
 *
 *   pnpm --filter api ai:prune-usage
 */

import { db } from "../prisma/db.js";
import { loadAiConfig } from "../services/ai/config.js";
import { pruneUsage } from "../services/ai/usage.js";

const days = loadAiConfig().usageRetentionDays;
const removed = await pruneUsage(days);
console.log(`Removed ${removed} AI usage row(s) older than ${days} days.`);
await db.close();
