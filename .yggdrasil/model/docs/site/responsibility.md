# Docs Site Config — Responsibility

VitePress documentation site infrastructure: package manifests for the docs build tool, and static public assets served alongside generated pages.

## Scope

- `package.json` / `package-lock.json` — VitePress and dependency declarations for the docs site build
- `public/` — Static assets: site logo (`logo.svg`), open-graph image, and other files served at the root of the docs site
- `.vitepress/` — VitePress site configuration (`config.ts`), custom theme (`theme/index.ts`, `theme/custom.css`), and related site-build setup

## Out of scope

- Documentation content (adopter guides) — belongs to `docs/guides`
- Internal design specifications — belongs to `docs/concept`
