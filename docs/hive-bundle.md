# Hive bundle

Everything needed to start building Hive, a personal Linear-issue-to-PR software factory, as a fork of [marshal-factory](https://github.com/ski043/marshal-factory) running agents through [T3 Code](https://github.com/pingdotgg/t3code) with [sstack](https://github.com/cobeo2004/sstack) skills.

Pinned to what these files were written against: marshal-factory `999ad20` (2026-10-31), T3 Code `965ddc1d`, sstack `6e1ab59`.

## What's inside

```
docs/
  prd.md          Product requirements: R1 to R26 in eight milestones, each naming the
                  marshal-factory files it changes, plus settled decisions and open questions
  glossary.md     One name per concept (job, lead thread, child, stage vs phase, evidence vs media)
playbooks/
  factory.md      The factory playbook on sstack work, bug-fix, feature and babysit,
                  replacing marshal-factory's PStack one
design/
  index.html      Gallery: open this first
  screens/        The eight screens as pages that open in a browser, with clicks working
    hive.css      The current tokens and components (source of truth for the look)
    support.js    Small runtime that renders the screens outside the design canvas
  png/            Full-page renders of every screen and state, dark and light
```

## Using the docs with sstack

1. Fork marshal-factory at `999ad20` and copy `docs/` and `playbooks/factory.md` into the fork, replacing its `playbooks/factory.md`.
2. In the fork root, ask your agent: "Use the sstack skill to set up this repo (route: setup). Link docs/prd.md and docs/glossary.md from product.md."
3. Grill one milestone at a time: "grill milestone M0 of docs/prd.md". Its `decisions.md` is the ticket `work` runs from, and `work` cites the R numbers.

## Viewing the design

Open `design/index.html`. Screens link to each other like the real app. URL options:

- `?dark=false` for light mode (dark is the default)
- Sign in: `?state=wrong-domain` or `?state=no-access`
- First-run setup: `?role=engineer` (the default is the first user, who is admin)

Fonts load from Google Fonts; offline, the screens fall back to system fonts. The screens use sample data only.
