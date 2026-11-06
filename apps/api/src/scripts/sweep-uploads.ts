/**
 * Removes uploaded files nothing has referenced for a day: the abandoned cover,
 * the attachment uploaded and never added. The server runs this daily; see
 * `sweepUnreferencedUploads` in `services/uploads.ts`.
 *
 *   pnpm --filter api uploads:sweep
 */

import { db } from "../prisma/db.js";
import { sweepUnreferencedUploads } from "../services/uploads.js";

// The sweep takes a batch at a time; repeat until a batch removes nothing.
let total = 0;
for (;;) {
  const removed = await sweepUnreferencedUploads();
  if (removed === 0) break;
  total += removed;
}
console.log(`Removed ${total} unreferenced upload(s).`);
await db.close();
