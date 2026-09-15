/**
 * Grants or revokes `auth.User.isAdmin`.
 *
 *   pnpm --filter api admin:grant <username>
 *   pnpm --filter api admin:grant <username> --revoke
 *
 * Deliberately a script rather than an endpoint. The flag is what authorises
 * hosting a writing challenge -- and what every later privileged surface will
 * read -- so there must be no request that can set it: an endpoint that grants
 * admin is a privilege-escalation bug waiting for one missing check, and the
 * first administrator has to come from outside the app anyway.
 *
 * Matches on username rather than id because that is what a person running
 * this knows. Usernames are stored lower-case (`lib/auth-schemas.ts` explains
 * why), so the argument is normalised the same way a login is.
 */

import { db } from "../prisma/db.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const revoke = args.includes("--revoke");
  const username = args.find((arg) => !arg.startsWith("--"))?.trim().toLowerCase();

  if (!username) {
    console.error(
      "Usage: pnpm --filter api admin:grant <username> [--revoke]",
    );
    process.exitCode = 1;
    return;
  }

  const user = await db.orm.auth.User.select("id", "username", "isAdmin")
    .where((row) => row.username.eq(username))
    .first();

  if (!user) {
    console.error(`No account with the username "${username}".`);
    process.exitCode = 1;
    return;
  }

  if (user.isAdmin === !revoke) {
    console.log(
      `${user.username} is already ${revoke ? "not " : ""}an administrator.`,
    );
    return;
  }

  await db.orm.auth.User.where((row) => row.id.eq(user.id)).update({
    isAdmin: !revoke,
  });

  console.log(
    `${user.username} is ${revoke ? "no longer" : "now"} an administrator.`,
  );
}

await main();
await db.close();
