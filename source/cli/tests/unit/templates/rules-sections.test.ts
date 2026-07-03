import { describe, it, expect } from 'vitest';
import { AGENT_RULES_CONTENT } from '../../../src/templates/rules.js';
import { KNOWLEDGE_TOPICS } from '../../../src/templates/knowledge/index.js';

describe('AGENT_RULES_CONTENT — required sections', () => {
  const REQUIRED_HEADINGS = [
    '### Working with architecture',
    '### Working with business-language requests',
    '### Per-node artifacts: what they are for',
    '### Log management',
    '### Finding entry points',
    '### Coordinated changes across multiple nodes',
    '### Onboarding the user, on demand',
  ];

  for (const h of REQUIRED_HEADINGS) {
    it(`contains heading ${h}`, () => {
      expect(AGENT_RULES_CONTENT).toContain(h);
    });
  }

  const REQUIRED_CLI_TABLE_ROWS = [
    '`yg find',
    '`yg log add',
    '`yg log read',
    '`yg log merge-resolve',
  ];

  for (const row of REQUIRED_CLI_TABLE_ROWS) {
    it(`CLI essentials table mentions ${row}`, () => {
      expect(AGENT_RULES_CONTENT).toContain(row);
    });
  }

  it('mentions log_required defaults to false (opt-in)', () => {
    expect(AGENT_RULES_CONTENT).toMatch(/log_required.*default.*false/s);
  });

  it('mentions yg log merge-resolve narrative in rules.ts', () => {
    expect(AGENT_RULES_CONTENT).toMatch(/yg log merge-resolve/);
  });

  it('mentions yg-suppress proposal step 1 — show the violation', () => {
    expect(AGENT_RULES_CONTENT).toMatch(/Show the user the violation/);
  });

  it('routes deep log topics (format, merge-resolve, recovery) to log-management knowledge', () => {
    expect(AGENT_RULES_CONTENT).toMatch(/yg knowledge read log-management/);
  });

  it('log-management knowledge topic documents yg log merge-resolve workflow', () => {
    expect(KNOWLEDGE_TOPICS['log-management'].content).toMatch(/yg log merge-resolve/);
  });

  it('cli-reference knowledge topic documents yg log merge-resolve', () => {
    expect(KNOWLEDGE_TOPICS['cli-reference'].content).toMatch(/yg log merge-resolve/);
  });

  const REQUIRED_KNOWLEDGE_ROUTES = [
    'yg knowledge read working-with-architecture',
    'yg knowledge read aspects-overview',
    'yg knowledge read writing-llm-aspects',
    'yg knowledge read writing-deterministic-aspects',
    'yg knowledge read conditional-aspects',
    'yg knowledge read suppress-syntax',
    'yg knowledge read verification-and-lock',
    'yg knowledge read configuration',
    'yg knowledge read cli-reference',
    'yg knowledge read log-management',
    'yg knowledge read ports-and-relations',
    'yg knowledge read flows',
    'yg knowledge read onboarding',
  ];

  for (const route of REQUIRED_KNOWLEDGE_ROUTES) {
    it(`rules.ts routes to ${route}`, () => {
      expect(AGENT_RULES_CONTENT).toContain(route);
    });
  }
});
