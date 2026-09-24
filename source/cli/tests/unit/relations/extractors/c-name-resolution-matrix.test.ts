import { describe, it } from 'vitest';
import { runCase } from '../reference-case-runner.js';

/**
 * C NAME-RESOLUTION IDENTIFICATION MATRIX — one runCase-backed test per identification
 * case under reference/relations/c/. C shares the include extractor and resolver with C++
 * (see c-cpp-name-resolution-matrix.test.ts for the full policy); this suite pins the forms
 * that are specific to C sources and headers: the `.c`/`.h` grammar routing, the dead-branch
 * guard on C preprocessor shapes (`#if (0)`, `__has_include` + `#elif 0`, `#elifdef`), the
 * `extern "C"` wrapper, and `#embed`. The two relations aspects (case-has-test +
 * case-is-tested) enforce the 1:1 catalogue↔test correspondence for the `c` catalogue.
 */

describe('MATRIX — C includes that resolve', () => {
  it('c-header-parses-as-c-routing-edge', () => runCase('c-header-parses-as-c-routing-edge'));
  it('c-extern-c-wrapper-edge', () => runCase('c-extern-c-wrapper-edge'));
});

describe('MATRIX — C dead branches and non-includes (SILENCE)', () => {
  it('c-if-paren-zero-silence', () => runCase('c-if-paren-zero-silence'));
  it('c-has-include-elif-zero-silence', () => runCase('c-has-include-elif-zero-silence'));
  it('c-elifdef-dead-branch', () => runCase('c-elifdef-dead-branch'));
  it('c-embed-silence', () => runCase('c-embed-silence'));
});
