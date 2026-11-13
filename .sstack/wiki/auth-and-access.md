---
summary: Better Auth with required TOTP, setup tokens, member vs admin, the proxy, and the cookie prefix trap
paths: lib/auth/**, proxy.ts, lib/access-links.ts, lib/members.ts, scripts/setup-token.ts, app/auth/**, app/api/auth/**
updated: 3588135
---

# Auth and access

- Better Auth with `baseURL: panelUrl()`, sign-up disabled, admin + twoFactor plugins
  (`lib/auth/server.ts:22-49`). The admin plugin's HTTP routes and TOTP disable/reveal routes are
  closed; roles change only through Members.
- **Member** = TOTP enabled and setup done; **admin** = member with `role === "admin"`
  (`lib/auth/owner.ts:11-18`). The last admin can't be demoted (`lib/members.ts:8-21`).
- **Proxy.** No session → 401 for APIs, sign-in redirect for pages; unfinished TOTP/setup → only
  `/setup` (`proxy.ts:7-24`). Public: `auth/*`, `api/auth|slack|ingest|webhooks`.
- **Setup token.** `bun scripts/setup-token.ts` prints a 1-hour link that works only while no admin
  exists; `--reset <email>` gives a 24-hour reset link. Only the sha256 is stored.

## Traps

- `panelUrl()` defaults to an https URL when `FACTORY_PANEL_URL` is unset (`lib/slack.ts:275`), and
  an https baseURL makes Better Auth prefix the cookie `__Secure-`. Locally, set
  `FACTORY_PANEL_URL=http://localhost:<port>` or a seeded session cookie signs you out.
- Many pages only check `currentUser()`; the proxy is what enforces TOTP and setup. `/api/live`
  checks `assertMember` itself.

Related: [accounts-and-credentials](accounts-and-credentials.md), [testing](testing.md).
