# Panel UI

Applies to `app/(panel)/**`, `app/layout.tsx`, `app/globals.css`, `components/**` and `design/**`. Panel behaviour (Jobs, Inbox, live updates) is in [operations.md § Panel access and deploys](../operations.md#panel-access-and-deploys); this page is the rules for changing how it looks and renders.

## Source of truth

- The look comes from `design/screens/hive.css` (the canvas in `design/index.html`). `app/globals.css` maps its tokens onto the shadcn variable layer for `:root` and `.dark` (R25a). **Fork, don't rewrite**: change variable *values*, keep variable names, routes and component names (PRD R25).
- Dark is the default: `ThemeProvider defaultTheme="dark"` in `app/layout.tsx`. Check both themes.
- Components start from `components/ui` (shadcn `base-nova`, `@base-ui/react`, Lucide icons per `components.json`). Add to `components/panel` only what the canvas needs.
- Tailwind 4 is CSS-first: tokens live in `@theme inline` in `app/globals.css`. No `tailwind.config`.

## Colour, type, icons

- Unibuz blue marks selection and focus. **Lime marks one thing**: a card at `pr` with every check green, plus the Inbox count badge (`isPrReady` in `components/panel/run-card.tsx`, pinned by `scripts/jobs-lime-regressions.ts`). Do not use it as decoration.
- Status colours come with `-soft` and `-foreground` variants (`--success`, `--warning`, `--info`, `--destructive`); use them rather than raw hex.
- Inter and JetBrains Mono load through `next/font` in `app/layout.tsx`. Sizes are the canvas's fixed values (for example 13.5px/19px for card titles). **No fluid type**: where the `responsive-design` skill suggests `clamp()` type, this page wins.

## Contrast gate

Every text and background pair in both themes reads at 4.5:1 or better. `scripts/contrast-regressions.ts` enforces it by compiling `app/globals.css` with Tailwind and reading the result through lightningcss, never regexes (L93, L115). After touching a token run `TEST_DATABASE_URL=... bun run test:regressions contrast`, and prove the gate by temporarily lightening `--muted-foreground` and seeing it fail.

- Use Tailwind's custom-property syntax for Hive tokens: `bg-(--primary-soft)`, `bg-(--lime) text-(--on-lime)`. Never reference a `--tw-*` variable in your own CSS (L145). The contrast gate also rejects `!important` that a bare `@import "tailwindcss"` compile does not emit, `@keyframes` or `@property` at any depth, and any custom property declared outside the scope and theme layers (L123, L130, L133).

## Data and rendering

- Server components read rows; `components/panel/live-refresh.tsx` follows the SSE stream (`/api/live`) and calls `router.refresh()`. That is the live model. Do not add SWR, polling or client caches.
- From `vercel-react-best-practices`, **skip**: `client-swr-dedup` (no SWR), `async-dependencies` (`better-all` is not a dependency), and the `optimizePackageImports` advice (Next already handles `lucide-react`). Follow its waterfall, bundle and re-render rules.
- No new dependency in a UI change. `package.json` and `bun.lock` are held for the owner.
- Panel defaults: Jobs opens on Everyone, Inbox on Mine. A link built outside the panel (`lib/slack.ts`) must land on a view that shows the job (L34, L39).
- Pages that import `db/client` need `DATABASE_URL` at build time; see [db.md](db.md).

## Workflow canvas (`@xyflow/react`)

Only `components/panel/workflow-flow.tsx` imports `@xyflow/react`, and `workflow-canvas.tsx` loads it client-only (`dynamic`, `ssr: false`). Keep it that way: import the library's stylesheet in that file, not in `app/globals.css`, because the contrast gate rejects unscoped rules (L182). Set theme colours inline from Hive variables, and remember that unlayered library rules beat Tailwind 4 utilities on `.react-flow__*` elements (L185). Backspace must never delete a step: `deleteKeyCode={null}` and filter `remove` changes (L186). The step panel is keyed so Cancel remounts it and drops pending edits (L187).

## Layout checks

- `components/panel/stats-strip.tsx` draws borders with `bg-border` and `gap-px`: confirm the last grid row has no empty cell at common widths (L85).
- Jobs rows must fit the pane at 1280px, and mobile widths must not scroll horizontally.

## Live check (required for any visible change)

1. `bun run dev` (needs `.env.local` with a database and `BETTER_AUTH_SECRET`), open the page in the T3 Code browser (`preview_*` tools) or a device.
2. Sign in with a seeded admin through the real flow: `bun scripts/setup-token.ts`, then `update two_factor set verified = true` (L32). Seeded users need `@unibuz.com.au` emails, or `createLink` refuses them (L165).
3. Board cards render only with a `runs` row on a `hive/` branch (L45).
4. Wait on `domcontentloaded` plus a selector. Never `networkidle`: the SSE stream keeps a connection open (L46).

## Media

A UI PR needs `media/before-<x>.png` and `media/after-<x>.png` pairs, or `media/no-before.md` for a new screen (L42). Capture headless with `playwright-core`, giving it an explicit `executablePath` to the cached `chromium_headless_shell-*` under `~/Library/Caches/ms-playwright` (L33, L166), and serve the panel on a port other agents do not hold: check with `lsof -iTCP:<port> -sTCP:LISTEN` (L167). "Screenshot timed out" is not evidence (L85), and a `skip.md` waiver (for example "no signed-in admin") does not satisfy a UI change (L179).

## Why

The panel's job is quick supervision by people who glance at it between other work. A stable token layer keeps the canvas, the code and the contrast tests agreeing; one live model keeps the board honest; and visible proof stops a restyle from shipping unseen.
