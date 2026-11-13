---
summary: Sealed tokens, owner-first-then-pool account choice, Cursor keys, and where secrets may go
paths: lib/creds.ts, lib/pool-accounts.ts, lib/account-logins.ts, runner/account-login.ts, runner/local-account.ts, runner/sandbox.ts, runner/lifecycle.ts, components/panel/your-accounts.tsx
updated: 3588135
---

# Accounts and credentials

- **Sealing.** X25519 + HKDF-SHA256 + AES-256-GCM (`lib/creds.ts:12-61`). The panel holds only
  `HIVE_CREDS_PUBLIC_KEY`, so it can seal but never read; runners hold the private key.
- **Choice.** `pickAccount`: the owner's own account under 95% of its 5-hour window, else the
  least-used pool account (unowned plus members' shared), else `"wait"` when `pauseInstead` is on
  (`lib/creds.ts:71-92`). `accountFor` keeps the account an attempt already used across wakes and
  skips recently rate-limited ones (`lib/creds.ts:103-162`).
- **Logins.** Connecting writes an `account_login` intent the runner acts on
  (`lib/account-logins.ts:22-31`). Disconnecting wipes `sealed` and sets `shared: false`.
- **Cursor.** A pasted API key is sealed on arrival; reconnect reseals the same row so its id and
  sharing survive (`lib/account-logins.ts:80-104`). Sandboxes get it as `CURSOR_API_KEY`
  (`runner/sandbox.ts:160-182`). Cursor is never the lead harness (R21).
- **Secrets reach sandboxes only as Modal env** (`sandboxSecrets`), files through the host file API,
  never a command line.

## Traps

- The 95% own-account cutoff is hard-coded; the pool threshold is config (`lib/creds.ts:87` vs `:90`).
- Admins can't add a Cursor pool account (`lib/pool-accounts.ts:20`); only a member's shared key pools.
- Engineers see shared accounts as `ownerId: "member"` (`lib/pool-accounts.ts:84-93`).
- Wake errors are scrubbed of all three secrets (`runner/lifecycle.ts:500-501`).

Related: [sandboxes-and-image](sandboxes-and-image.md), [auth-and-access](auth-and-access.md).
