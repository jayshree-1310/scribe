#!/bin/sh
# Migrate, then serve. The reasoning for both halves lives in
# scripts/migrate-on-boot.mjs; this file only sequences them.
set -e

node scripts/migrate-on-boot.mjs

# exec, so node replaces the shell as PID 1 and receives Render's SIGTERM
# directly -- otherwise the shell holds PID 1 and the server never runs its
# shutdown path.
exec node dist/server.js
