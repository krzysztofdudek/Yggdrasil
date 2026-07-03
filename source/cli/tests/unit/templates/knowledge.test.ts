import { describe, it, expect } from 'vitest';
import { KNOWLEDGE_TOPICS } from '../../../src/templates/knowledge/index.js';

describe('KNOWLEDGE_TOPICS', () => {
  it('exports exactly 15 topics', () => {
    expect(Object.keys(KNOWLEDGE_TOPICS).length).toBe(15);
  });

  it('has expected topic names', () => {
    const names = Object.keys(KNOWLEDGE_TOPICS).sort();
    expect(names).toEqual([
      'aspect-status',
      'aspects-overview',
      'cli-reference',
      'conditional-aspects',
      'configuration',
      'flows',
      'log-management',
      'meta-modeling',
      'onboarding',
      'ports-and-relations',
      'suppress-syntax',
      'verification-and-lock',
      'working-with-architecture',
      'writing-deterministic-aspects',
      'writing-llm-aspects',
    ]);
  });

  it('each topic has summary and content', () => {
    for (const [, topic] of Object.entries(KNOWLEDGE_TOPICS)) {
      expect(topic.summary).toBeDefined();
      expect(topic.summary.length).toBeGreaterThan(0);
      expect(topic.content).toBeDefined();
      expect(topic.content.length).toBeGreaterThan(50);
    }
  });

  const REQUIRED_HEADINGS: Record<string, string[]> = {
    onboarding: [
      '## Activation',
      '## The experience contract',
      '## Three contexts',
      '## Lesson menu — YOU hold the menu',
      '## Zero-trace demo recipes',
      '## Closing every session',
    ],
    'working-with-architecture': [
      '## Type kinds',
      '## Predicate grammar',
      '## When to use enforce: strict',
      '## Pitfalls',
    ],
    'aspects-overview': [
      '## What an aspect is',
      '## When to create an aspect',
      '## Three reviewer kinds',
      '## Cost model',
      '## Aspect status',
    ],
    'writing-llm-aspects': [
      '## content.md format',
      '## Writing the rules',
      '## Cost considerations',
      '## False-positive mitigation',
    ],
    'writing-deterministic-aspects': [
      '## Runtime contract',
      '## Minimal API — imports from `@chrisdudek/yg/ast`',
      '## Quick reference — raw tree-sitter API',
      '## The ctx surface',
      '## parseAst is synchronous',
      '## Allowed reads set (D9=A)',
      '## Testing with yg aspect-test',
      '## Adoption workflow',
      '## Cookbook',
    ],
    'conditional-aspects': [
      '## Aspect-level when grammar',
      '## Applicability examples',
      '## Propagation through channels',
    ],
    'suppress-syntax': ['## Single-line', '## Bracket', '## Wildcard', '## When to suppress'],
    'verification-and-lock': [
      '## Pairs and units',
      '## Lock format',
      '## inputHash — the frozen contract',
      '## Caching policy',
      '## Merge conflict in a committed lock file',
      '## Reverting a node',
    ],
    configuration: [
      '## yg-config.yaml reference',
      '## Reviewer tiers',
      '## Secrets',
      '## Quality thresholds',
    ],
    'cli-reference': [
      '## yg check',
      '## yg check --approve',
      '## yg aspect-test',
      '## yg context',
      '## yg impact',
      '## yg type-suggest',
      '## yg knowledge',
      '## yg schemas',
    ],
    'log-management': [
      '## Format constraints',
      '## Recovery from typo',
      '## Reverting a change',
      '## After a git merge',
      '## Large logs',
    ],
    'ports-and-relations': [
      '## Relation types',
      '## Why ports exist',
      '## Missing port contracts',
      '## When to use ports',
    ],
    flows: [
      '## Flow file structure',
      '## Descendant inclusion',
      '## Flow-level aspect propagation',
      '## When to create a flow',
    ],
    'aspect-status': [
      '## Declaration sites',
      '## Effective status rule',
      '## Implies propagation',
      '## Status and verdicts',
      '## When to use which status',
    ],
  };

  it('each topic contains all required H2 headings', () => {
    for (const [name, headings] of Object.entries(REQUIRED_HEADINGS)) {
      const content = KNOWLEDGE_TOPICS[name].content;
      for (const h of headings) {
        expect(content, `${name} missing heading "${h}"`).toMatch(
          new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'm'),
        );
      }
    }
  });

  it('each topic content is at least 1500 chars', () => {
    for (const [name, topic] of Object.entries(KNOWLEDGE_TOPICS)) {
      expect(topic.content.length, `${name} content too short`).toBeGreaterThan(1500);
    }
  });
});
