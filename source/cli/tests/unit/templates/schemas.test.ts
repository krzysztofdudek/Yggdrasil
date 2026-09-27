import { describe, it, expect } from 'vitest';
import { SCHEMA_TOPICS } from '../../../src/templates/schemas/index.js';
import { FILE_FORMATS } from '../../../src/utils/file-formats.js';

describe('SCHEMA_TOPICS', () => {
  it('has one annotated example per file format the CLI reads, and no other', () => {
    expect(Object.keys(SCHEMA_TOPICS).sort()).toEqual(FILE_FORMATS.map((f) => f.name).sort());
  });

  it('has expected schema names (regression pin)', () => {
    const names = Object.keys(SCHEMA_TOPICS).sort();
    expect(names).toEqual(['architecture', 'aspect', 'aspect-adapt', 'config', 'flow', 'marketplace', 'node', 'package', 'packages', 'secrets']);
  });

  it('each schema has a non-empty summary and YAML-shaped content', () => {
    for (const format of FILE_FORMATS) {
      expect(format.summary.length, format.name).toBeGreaterThan(10);
      const topic = SCHEMA_TOPICS[format.name];
      expect(topic.content.length, format.name).toBeGreaterThan(100);
      expect(topic.content, format.name).toMatch(/^# yg-[\w.]+\.yaml/m);
    }
  });

  it('repoints internal cross-references at the command (no schemas/ paths leak through)', () => {
    for (const [slug, topic] of Object.entries(SCHEMA_TOPICS)) {
      expect(topic.content, slug).not.toMatch(/schemas\/yg-/);
    }
  });

  it('normalizes the config version example off the old 5.0.0 literal', () => {
    expect(SCHEMA_TOPICS.config.content).not.toMatch(/version: "5\.0\.0"/);
  });
});
