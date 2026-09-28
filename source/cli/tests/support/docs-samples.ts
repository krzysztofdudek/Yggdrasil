// =============================================================================
// Terminal samples on the docs pages, recorded from the CLI.
//
// A page shows what a command prints in a ```text block. A copy pasted by hand
// keeps the words of the build it was pasted from, and the docs showed an
// aspect-test report, a tree footer and an owner answer the CLI had stopped
// printing. A sample registered here is instead recorded: the block right
// after a `<!-- sample: <name> -->` marker on its page is the command's output
// in one small project (tests/fixtures/docs-samples: two components, three
// files covered by their architecture type alone, a script rule a file breaks,
// a reviewer rule no sample calls). The guard (tests/e2e/docs-samples.test.ts)
// records every sample and compares; `npm run docs-samples:update` in
// source/cli writes the blocks.
//
// Imports only Node builtins and its siblings, never anything under src/**.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BIN_PATH, CLI_ROOT, REPO_ROOT } from './cli-help-tree.js';
import { copyFixtureTree } from './fixture-copy.js';
import { FIXTURE_RM_OPTIONS, runGitFixture } from './git-fixture.js';

export const DOCS_SAMPLES_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'docs-samples');

/** One recorded sample: where it is shown, what is run, and what of the output the page shows. */
export interface DocsSample {
  name: string;
  /** The page it is on, relative to the repository root. */
  page: string;
  /** The command's arguments after `yg`. */
  args: string[];
  /** Whether the block opens with the command line, `$ yg …`, and a blank line is not kept after it. */
  prompt: boolean;
  /** The lines of the output the page shows, when it shows only some. */
  pick?: (output: string) => string;
}

export const DOCS_SAMPLES: DocsSample[] = [
  { name: 'aspect-test-refused', page: 'docs/reviewers.md', args: ['aspect-test', '--aspect', 'async-fs', '--node', 'utils'], prompt: false },
  {
    name: 'impact-cost-line',
    page: 'docs/cli-reference.md',
    args: ['impact', '--node', 'orders/order-service'],
    prompt: false,
    pick: (out) => out.split('\n').filter((l) => l.trimStart().startsWith('Editing this node re-verifies')).join('\n'),
  },
  { name: 'tree-type-covered', page: 'docs/cli-reference.md', args: ['tree'], prompt: true },
  { name: 'owner-file-type', page: 'docs/cli-reference.md', args: ['owner', '--file', 'src/handlers/capturePayment.ts'], prompt: true },
  {
    name: 'owner-files-batch',
    page: 'docs/cli-reference.md',
    args: ['owner', '--files', 'src/orders/order.service.ts,src/handlers/capturePayment.ts,src/nope.ts'],
    prompt: true,
  },
];

/** The environment a person's shell gives the CLI: no colour, no CI, no leaked git plumbing. */
function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  for (const k of Object.keys(e)) if (k.startsWith('GIT_')) delete e[k];
  for (const k of ['FORCE_COLOR', 'CI', 'GITHUB_ACTIONS']) delete e[k];
  return e;
}

/** Every sample's block text, recorded in one committed copy of the samples project. */
export function recordSamples(): Map<string, string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-docs-samples-'));
  try {
    copyFixtureTree(DOCS_SAMPLES_FIXTURE, dir);
    runGitFixture(dir, ['init', '-q']);
    runGitFixture(dir, ['add', '-A']);
    runGitFixture(dir, ['commit', '-q', '-m', 'the project the docs samples are recorded in']);
    const out = new Map<string, string>();
    for (const s of DOCS_SAMPLES) {
      const r = spawnSync('node', [BIN_PATH, ...s.args], { cwd: dir, encoding: 'utf-8', env: env(), timeout: 60_000 });
      const printed = ((r.stdout ?? '') + (r.stderr ?? '')).split(dir).join('<project>').trimEnd();
      const shown = (s.pick ?? ((t: string) => t))(printed);
      out.set(s.name, s.prompt ? `$ ${['yg', ...s.args].join(' ')}\n${shown}` : shown);
    }
    return out;
  } finally {
    rmSync(dir, FIXTURE_RM_OPTIONS);
  }
}

const BLOCK = /<!-- sample: ([\w-]+) -->\n```text\n([\s\S]*?)\n```/g;

/** The recorded sample blocks on a page: the name each marker gives and the block's text. */
export function sampleBlocks(page: string): Array<{ name: string; text: string }> {
  return [...page.matchAll(BLOCK)].map((m) => ({ name: m[1], text: m[2] }));
}

/** The page with every recorded block rewritten from `recorded`; a marker naming no sample is left as it is. */
export function renderSampleBlocks(page: string, recorded: Map<string, string>): string {
  return page.replace(BLOCK, (whole, name: string) => {
    const text = recorded.get(name);
    return text === undefined ? whole : `<!-- sample: ${name} -->\n\`\`\`text\n${text}\n\`\`\``;
  });
}

/** The pages that carry recorded samples. */
export function samplePages(): string[] {
  return [...new Set(DOCS_SAMPLES.map((s) => s.page))].map((p) => path.join(REPO_ROOT, p));
}
