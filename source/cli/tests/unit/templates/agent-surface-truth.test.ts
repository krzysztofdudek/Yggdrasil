// =============================================================================
// Unit — what an agent reads every session says the same thing everywhere.
//
// The operating manual (`yg prime`), the knowledge topics, the schema references
// and the glossary each describe some of the same behaviour. When one of them
// kept an old description after the behaviour changed, the agent was told two
// different things and followed whichever it read last. The shared sentences
// live once, in the knowledge layer's shared-text module; the knowledge topics
// interpolate them, but the manual's template cannot import them, so this suite
// holds the manual's copy to those exact strings — and holds the manual's status
// words to the glossary's definitions, which also feed the docs Glossary page
// and the portal's tooltips.
//
// Hermetic & fast: reads template modules and evaluates the glossary browser
// module in a vm sandbox; spawns nothing.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { AGENT_RULES_CONTENT } from '../../../src/templates/rules.js';
import { KNOWLEDGE_TOPICS } from '../../../src/templates/knowledge/index.js';
import { SCHEMA_TOPICS } from '../../../src/templates/schemas/index.js';
import {
  AUTO_APPROVE_READ_ONLY_CASES,
  RULE_SUPPORT_FILES,
  SUPPRESS_SINGLE_LINE_SCOPE,
} from '../../../src/templates/knowledge/shared-text.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GLOSSARY_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'templates', 'portal', 'js', 'glossary.js');

function glossaryDef(id: string): string {
  const window: Record<string, unknown> = {};
  vm.runInNewContext(readFileSync(GLOSSARY_PATH, 'utf-8'), { window });
  const glossary = (window.YgPortal as { glossary: { entries: Array<{ id: string; def: string }> } }).glossary;
  const entry = glossary.entries.find((e) => e.id === id);
  expect(entry, `glossary entry ${id}`).toBeDefined();
  return entry!.def;
}

const topic = (name: string): string => KNOWLEDGE_TOPICS[name].content;

/** Where each shared sentence must appear word for word. */
const SHARED: Array<{ name: string; text: string; topics: string[] }> = [
  {
    name: 'the read-only cases of auto_approve (CI hold-back, triage views)',
    text: AUTO_APPROVE_READ_ONLY_CASES,
    topics: ['configuration', 'cli-reference', 'verification-and-lock'],
  },
  {
    name: "a rule's support files",
    text: RULE_SUPPORT_FILES,
    topics: ['verification-and-lock', 'aspects-overview'],
  },
  {
    name: 'the line a single-line or trailing yg-suppress marker waives',
    text: SUPPRESS_SINGLE_LINE_SCOPE,
    topics: ['suppress-syntax'],
  },
];

describe('shared sentences read the same in the manual and the knowledge topics', () => {
  for (const s of SHARED) {
    it(`the manual carries ${s.name} word for word`, () => {
      expect(AGENT_RULES_CONTENT).toContain(s.text);
    });
    for (const t of s.topics) {
      it(`knowledge topic ${t} carries ${s.name} word for word`, () => {
        expect(topic(t)).toContain(s.text);
      });
    }
  }
});

describe('status words in the manual are the glossary definitions', () => {
  for (const id of ['status', 'draft', 'advisory', 'enforced']) {
    it(`the manual carries the glossary definition of ${id}`, () => {
      expect(AGENT_RULES_CONTENT).toContain(glossaryDef(id));
    });
  }

  it('every paragraph of the manual that says advisory never blocks names the prompt-too-large exception', () => {
    const paragraphs = AGENT_RULES_CONTENT.split('\n\n').filter((p) => /advisory/i.test(p) && /never blocks?\b/i.test(p));
    expect(paragraphs.length).toBeGreaterThan(0);
    for (const p of paragraphs) expect(p).toContain('prompt-too-large');
  });

  it('the manual never calls status rendering only, and the aspect-status topic says it is not', () => {
    expect(AGENT_RULES_CONTENT.replace(/not rendering only/g, '')).not.toMatch(/rendering only/);
    expect(topic('aspect-status')).toContain('it is NOT rendering only');
  });
});

describe('the manual and the references say what the commands do', () => {
  it('yg simulate is not called read-only: it runs the candidate check.mjs', () => {
    const row = AGENT_RULES_CONTENT.split('\n').find((l) => l.startsWith('| `yg simulate'));
    expect(row).toBeDefined();
    expect(row).not.toMatch(/read-only/i);
    expect(row).toContain('RUNS the candidate');
  });

  it('the knowledge reference describes yg aspects --health --json instead of calling it refused', () => {
    const ref = topic('cli-reference');
    expect(ref).not.toMatch(/refused\s+together with\s+`--json`/);
    expect(ref).toContain('`yg aspects --health --json` prints the health view as one `yg-aspects-health/1`');
  });

  it('the aspect schema names content.md as the one file the reviewer is shown', () => {
    const schema = SCHEMA_TOPICS.aspect.content;
    expect(schema).not.toMatch(/any number of \.md/);
    expect(schema).toContain('the ONLY file of the directory the reviewer is shown as the rule');
  });

  it('the config schema says a committed full is held back under CI', () => {
    expect(SCHEMA_TOPICS.config.content).toContain('HELD BACK UNDER CI');
  });

  it('the manual no longer says a single-line marker waives only the line below', () => {
    expect(AGENT_RULES_CONTENT).not.toContain('waives ONLY the line directly below');
  });
});
