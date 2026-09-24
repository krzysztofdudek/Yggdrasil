import { describe, it } from 'vitest';
import { runCase } from '../reference-case-runner.js';

/**
 * JAVASCRIPT NAME-RESOLUTION IDENTIFICATION MATRIX — one runCase-backed test per case in
 * reference/relations/javascript/. JavaScript shares the TypeScript extractor and path
 * resolver; these cases pin what is specific to `.js`/`.mjs`/`.cjs`/`.jsx` sources and the
 * JavaScript grammar (JSX in `.js`, CommonJS, JSDoc comments, the grammar's ERROR on
 * re-export attributes).
 */

describe('MATRIX — JavaScript sources', () => {
  it('javascript-cjs-require-edge', () => runCase('javascript-cjs-require-edge'));
  it('javascript-export-from-with-attributes-edge', () => runCase('javascript-export-from-with-attributes-edge'));
  it('javascript-jsdoc-import-silence', () => runCase('javascript-jsdoc-import-silence'));
  it('javascript-jsx-in-js-edge', () => runCase('javascript-jsx-in-js-edge'));
  it('javascript-mjs-import-edge', () => runCase('javascript-mjs-import-edge'));
});
