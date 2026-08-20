import type { GoldenRepoSpec } from '../../../../support/roots-golden.js';

// =============================================================================
// tests/fixtures/roots/golden/python/spec.ts — the Python golden's builder
// spec, deliberately ROLE-RICH (unlike the other five code goldens, which
// are deliberately role-FREE so their candidate/fact arithmetic stays
// hand-tractable — see the typescript golden's own header). This is the one
// golden `tests/unit/roots/golden-controls.test.ts`'s NULL CONTROL runs
// against: a shuffled-label null on a partition with NO real roles would be
// a vacuous "0 accepted role conventions" (there was nothing to destroy),
// so this golden is shaped to produce genuine, non-trivial role-conditioned
// FACTS for the control to meaningfully zero out.
//
// SHAPE: `PACKAGE_COUNT` (60) directories `src/pkg<i>/`, each holding TWO
// files:
//   - `repo.py`: `class Repository(BaseRepository):` with two methods,
//     `find_by_id(self, id)` (arity 2) and `save_record(self)` (arity 1),
//     both calling `db.execute(...)`.
//   - `service.py`: `class Service(BaseService):` with two methods,
//     `validate_input(self, data)` (arity 2) and `process_request(self)`
//     (arity 1), both calling `logger.info(...)`.
//
// The class name, method names, supertype and callee are LITERAL constants
// repeated across all 60 packages (never index-suffixed) — `stable_id`
// disambiguates identity via `relPath` alone, and identical literal name
// tokens are what gives every instance of "Repository", "find_by_id", etc.
// an IDENTICAL §8.1 feature bag, so role induction's average-linkage cut
// finds four clean, well-separated clusters (Repository, Service,
// find_by_id, save_record, validate_input, process_request — six, not
// four; every method name is its own cluster too) rather than a fragile
// near-miss the reviewer would have to trust by construction alone.
//
// The call convention is role-SPECIFIC, not partition-wide: `_all:method`
// sees `auto.call:db.execute` true for exactly HALF the population (the two
// repository methods) and false for the other half — a 50/50 split that
// never clears fire-ability at the partition level — while the ROLE cell
// for (e.g.) `find_by_id` sees it true 100% of the time. This is exactly
// the role-conditioned-vs-partition-average contrast spec §9.4a's baseline
// exists to detect, and it is this golden's own MUST-mine assertion
// (`tests/unit/roots/golden-python.test.ts`): at least one ACCEPTED fact
// whose `roleKey` is neither `_all` nor a directory context.
//
// `find_by_id`/`validate_input` (arity 2) vs `save_record`/`process_request`
// (arity 1) split `auto.arity` exactly 50/50 at `_all:method` — the
// deliberate MUST-NOT-mine control every golden in this suite carries.
//
// Raw scopes: 60 packages * 2 files * (1 type + 2 method + 1 file) =
// 60 * 8 = 480, clearing spec §6.8's 300-scope floor with 60% margin.
// =============================================================================

const PACKAGE_COUNT = 60;

const REPO_FILE = [
  'class Repository(BaseRepository):',
  '    def find_by_id(self, id):',
  '        db.execute("x")',
  '        return 1',
  '',
  '    def save_record(self):',
  '        db.execute("x")',
  '        return 1',
  '',
].join('\n');

const SERVICE_FILE = [
  'class Service(BaseService):',
  '    def validate_input(self, data):',
  '        logger.info("x")',
  '        return 1',
  '',
  '    def process_request(self):',
  '        logger.info("x")',
  '        return 1',
  '',
].join('\n');

export function buildPythonGoldenSpec(): GoldenRepoSpec {
  const files: Record<string, string> = {};
  for (let i = 0; i < PACKAGE_COUNT; i++) {
    files[`src/pkg${i}/repo.py`] = REPO_FILE;
    files[`src/pkg${i}/service.py`] = SERVICE_FILE;
  }

  return {
    name: 'python',
    commits: [
      { author: 'roots-golden', files, message: 'seed: 60 uniform repository+service packages' },
      // D8's time-depth anchor — see tests/fixtures/roots/golden/data/spec.ts's own comment for why.
      { author: 'roots-golden', dayOffset: 400, files: { 'NOTES.md': 'Time-depth anchor commit — no registered grammar, no scopes, no partition marker.\n' }, message: 'chore: trailing note (time-depth anchor)' },
    ],
  };
}
