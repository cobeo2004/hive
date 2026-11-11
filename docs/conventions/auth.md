# Sign-in and sessions

Applies to `lib/auth/**`, `proxy.ts`, `app/auth/**`, `app/setup/**`, `app/actions/**` and `components/auth/**`. `lib/auth/**` and `proxy.ts` are held files (`never_merge`): a change here is reviewed by a person, so keep diffs small and say what was tested. The behaviour (first admin, invites, resets, roles) is in [operations.md § Panel access and deploys](../operations.md#panel-access-and-deploys).

## The model

- Better Auth 1.7 with the `admin` and `twoFactor` plugins, configured in `lib/auth/server.ts`. Roles are `admin` and `engineer`; the admin plugin's HTTP routes are closed.
- A **member** has TOTP enrolled **and** `setupDoneAt` set (`isMember` in `lib/auth/owner.ts`). Until then only `/setup` is open. Enrolling ends every other session of the user.
- Sign-up is closed (`disableSignUp: true`). Accounts come from the one-time setup token or an invite, created server-side in `lib/access-links.ts`. Tokens are stored as sha256 only.
- Tailscale is optional. Nothing in sign-in, routing or setup may depend on it (L15).

## Hive is not Better Auth's default setup

Better Auth's guides and the registry's `better-auth` skills teach several things Hive deliberately does not do. Do not add them:

| Guide says | Hive |
|---|---|
| `trustDevice: true`, remember this device | no trusted device: `verify-*` bodies are forced to `trustDevice: false` |
| email or SMS OTP via `sendOTP` | Hive sends no email; `/two-factor/send-otp` and `verify-otp` are closed |
| email verification, open sign-up | sign-up closed; links are handed over by a person |
| disable or regenerate backup codes from the UI | `disable`, `get-totp-uri`, `generate-backup-codes` are closed |
| `BETTER_AUTH_URL` | `FACTORY_PANEL_URL` (`panelUrl()` in `lib/slack.ts`) |
| `npx auth generate` then `drizzle-kit push` | a hand-checked migration; see [db.md](db.md) |

The closed endpoints live in `CLOSED_TWO_FACTOR` and the `before` hook in `lib/auth/server.ts`. Opening one is a product decision, not a refactor.

## Server code

- Read the session through `session.read` (`lib/auth/server.ts`). It builds headers from `cookies()`, not `headers()`: after a server action sets a cookie Next 16 re-renders with the new cookie in `cookies()` but the old one in `headers()`, and `/setup` would bounce to sign-in (L13).
- `setUserPassword` and `setRole` need an admin session (`adminMiddleware`). From server code use `internalAdapter` (`updatePassword`, `linkAccount`, `deleteUserSessions`) plus a guarded update (L9).
- `SessionUser.id` is optional. After `isMember(me)`, still guard `!me.id` before inserting a per-user row (L71).
- The proxy only gates navigation. A route handler checks `isMember` itself (`app/api/jobs/[key]/device-frame/route.ts`), and a server action passes `currentUser` into the `lib/` function that decides, as `app/actions/settings.ts` does with `lib/settings.ts`. Admin-only pages check `isAdmin`. The last admin cannot be demoted (`LAST_ADMIN` in `lib/members.ts`).

## Routes and the proxy

- `proxy.ts` replaces middleware (Next 16). It sends a sessionless request to `/auth/sign-in` (`/api/*` gets 401) and a not-yet-member to `/setup` (`/api/*` gets 403).
- The matcher excludes the public paths: `auth/*` link pages, `api/auth`, `api/slack`, `api/ingest`, `api/webhooks`, static assets. Each public path checks its own Bearer secret, signature or link token. A new public path needs its own check **and** a line in `scripts/public-paths-regressions.ts`.
- `/setup` lives at `app/setup`, not inside `(panel)`, because the panel layout assumes a member (L11).

## Testing and review

- See [regressions.md](regressions.md) for stubbing `session.read`, TOTP and `setupDoneAt` fixtures. `scripts/auth-flow-regressions.ts`, `proxy-regressions.ts` and `public-paths-regressions.ts` cover the contract; run them for any change here.
- Word a re-review as a correctness review of a named commit range with the test commands. "Reproduce an exploit" phrasing makes some delegates refuse (L16).

## Why

The panel is internal and reachable from the internet, and its only gate is one password plus one TOTP code. Every convenience feature (trusted devices, email codes, open sign-up) is a way around the second factor, which is why the list above is closed by default.
