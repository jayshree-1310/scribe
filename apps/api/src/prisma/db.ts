import 'dotenv/config';
// The contract's `DateTime` columns use Postgres' Temporal-backed codecs, which
// read and write through the global `Temporal` API. Node does not ship one yet,
// so every read or write of a timestamp — including the `@default(now())`
// columns every model has — fails with RUNTIME.TEMPORAL_UNAVAILABLE without
// this. It must be imported before the client below is created.
import 'temporal-polyfill/global';
import postgres from '@prisma/orm-postgres/runtime';
import type { Contract } from './contract.d';
import contractJson from './contract.json' with { type: 'json' };

export const db = postgres<Contract>({
  contractJson,
  url: process.env['DATABASE_URL']!,
});
