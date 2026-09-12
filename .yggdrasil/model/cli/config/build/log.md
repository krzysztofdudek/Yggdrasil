## [2026-09-12T08:42:07.193Z]
Pinned `vite` as an explicit devDependency alongside the vitest 4 -> 5 upgrade. Nothing in this repository imports vite directly, so the entry looks removable and is not: it is load-bearing for the entire test suite.

Vitest 4 carried `vite` in its own `dependencies`, so it arrived transitively and never needed naming here. Vitest 5 moved it to a peerDependency that is explicitly NOT optional. This package sets `legacy-peer-deps=true` in `source/cli/.npmrc`, and under that flag npm never auto-installs peer dependencies. The two facts combine badly: without an explicit entry, `npm install` succeeds and reports no error, then every vitest invocation dies at startup with `ERR_MODULE_NOT_FOUND: Cannot find package 'vite'` — the whole suite, not one test.

The version range tracks vitest 5's declared peer window (`^6.4.0 || ^7.0.0 || ^8.0.0`); 8.x is the current stable major. Keep this entry in step with that window on future vitest majors, and do not let a dependency-pruning pass drop it for being unimported.
