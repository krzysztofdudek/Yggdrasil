/**
 * The static reading of which ctx.config keys a rule script reads (src/structure/config-reads.ts),
 * through the parser host and the `walk` Yggdrasil now takes from @chrisdudek/runes. Every shape
 * that names a key reports it; every shape that cannot sets `dynamic` instead of guessing.
 */
import { describe, it, expect } from 'vitest';
import { collectConfigReads } from '../../../src/structure/config-reads.js';

const read = (source: string) => collectConfigReads('rule/check.mjs', source);

describe('collectConfigReads', () => {
  it('reads the context parameter name off the check declaration, whatever its form', async () => {
    expect(await read('export function check(c) { return c.config.limit; }')).toEqual({ keys: ['limit'], dynamic: false });
    expect(await read('export const check = (c) => c.config.limit;')).toEqual({ keys: ['limit'], dynamic: false });
    expect(await read('export const check = c => c.config.limit;')).toEqual({ keys: ['limit'], dynamic: false });
    expect(await read('export const check = function (c) { return c.config.limit; };')).toEqual({ keys: ['limit'], dynamic: false });
    // no check declaration, or one whose first parameter is a pattern: the conventional name
    expect(await read('const x = ctx.config.limit;')).toEqual({ keys: ['limit'], dynamic: false });
    expect(await read('export function check({ config }) { return ctx.config.limit; }')).toEqual({ keys: ['limit'], dynamic: false });
    // a `check` that is not a function names no parameter
    expect(await read('export const check = 1; const y = ctx.config.a;')).toEqual({ keys: ['a'], dynamic: false });
  });

  it('names a template-literal subscript with no substitution, empty or not', async () => {
    expect(await read('export function check(ctx) { return ctx.config[`b`]; }')).toEqual({ keys: ['b'], dynamic: false });
    expect(await read('export function check(ctx) { return ctx.config[``]; }')).toEqual({ keys: [''], dynamic: false });
  });

  it('names literal subscripts, including the empty key', async () => {
    const r = await read("export function check(ctx) { return [ctx.config['a'], ctx.config['']]; }");
    expect(r).toEqual({ keys: ['', 'a'], dynamic: false });
  });

  it('marks a computed or substituted subscript as dynamic', async () => {
    expect((await read('export function check(ctx) { const k = "a"; return ctx.config[k]; }')).dynamic).toBe(true);
    expect((await read('export function check(ctx) { const k = "a"; return ctx.config[`x${k}`]; }')).dynamic).toBe(true);
  });

  it('names destructured properties and renames; a rest element or a non-object binding is dynamic', async () => {
    expect(await read('export function check(ctx) { const { a, b: bee } = ctx.config; return a + bee; }')).toEqual({ keys: ['a', 'b'], dynamic: false });
    expect(await read('export function check(ctx) { const { a, ...rest } = ctx.config; return [a, rest]; }')).toEqual({ keys: ['a'], dynamic: true });
    expect(await read('export function check(ctx) { const [x] = ctx.config; return x; }')).toEqual({ keys: [], dynamic: true });
    expect(await read('export function check(ctx) { const cfg = ctx.config; return cfg.a; }')).toEqual({ keys: [], dynamic: true });
  });

  it('marks any other appearance of the object as dynamic', async () => {
    expect(await read('export function check(ctx) { return helper(ctx.config); }')).toEqual({ keys: [], dynamic: true });
    expect(await read('export function check(ctx) { return { ...ctx.config }; }')).toEqual({ keys: [], dynamic: true });
    expect(await read('export function check(ctx) { return ctx.config.#p; }')).toMatchObject({ dynamic: true });
  });
});
