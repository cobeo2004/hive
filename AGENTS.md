Read .sstack/product.md before any task.

## Things agents get wrong

- Running lint, format:check or tsc in a fresh worktree before `bun install --frozen-lockfile` — enforcer: `.sstack/project.toml` verify installs first
- Formatting with prettier, or committing unformatted .ts/.tsx, instead of `bun run format` (Biome) — enforcer: `bun run format:check` in verify and CI
