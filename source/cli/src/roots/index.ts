/**
 * Public surface of the roots ENGINE (only) for CLI-layer consumers
 * (`src/cli/roots.ts` today; any future extraction-package consumer
 * tomorrow). Re-exports exactly the engine-owned names `cli/roots.ts` imports
 * from `src/roots/**` — no more — so that file (and anything that follows it)
 * can depend on one seam instead of four deep paths.
 *
 * Deliberately does NOT re-export anything from `./stores.js`: `stores.ts` is
 * mapped to the separate `cli/roots/stores` graph node (architecture type
 * `roots-store`), and the architecture's own allow-list permits NO relation
 * type from `roots-engine` to `roots-store` in either direction — "engine
 * never imports the store" (see `stores.ts`'s own header comment). This file
 * itself is forced into the `roots-engine` type by that architecture type's
 * file-pattern `when` (any bare `*.ts` directly under `src/roots/`, `stores.ts`
 * and tests excepted), so an `export … from './stores.js'` here would create
 * exactly the forbidden edge (`relation-undeclared-dependency` catches this
 * for real: it fired on an earlier draft of this file that did re-export the
 * store's surface). `cli/roots.ts` keeps importing the store's exports by
 * their own deep path (`../roots/stores.js`) — unchanged from before this
 * file existed — precisely because it is the one sanctioned composer of both
 * sides (its own header comment says so).
 *
 * Internal engine modules keep importing each other by deep path as before;
 * only the CLI-layer entry point's ENGINE half changes. Tests keep their
 * existing deep imports (they test internals, not the public surface) and are
 * unaffected by this file.
 */

export { rootsConfigHash } from './config.js';

export { runRootsIndex, computeUsedGrammarSetHash } from './pipeline.js';

export { isMinedModel, type MinedModel } from './mine.js';

export {
  resolveWalkMode,
  isWindowingActive,
  type WalkMode,
  type HistoryProgressInfo,
} from './history.js';
