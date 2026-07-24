import { describe, it, expect } from 'vitest';
import {
  DIGEST_BODY, digestSha256, digestAnchor, digestBlockBody, ANCHOR_RE,
} from '../../../src/templates/digest.js';

describe('digest template', () => {
  it('body is small, LF-only, and carries the mandate + package name', () => {
    expect(DIGEST_BODY.length).toBeLessThan(4096);
    expect(DIGEST_BODY).not.toContain('\r');
    expect(DIGEST_BODY).toContain('yg prime');
    expect(DIGEST_BODY).toContain('@chrisdudek/yg');
    expect(DIGEST_BODY).toContain('yg-suppress');
    expect(DIGEST_BODY).toContain('review_by');
  });

  it('sha256 is EOL-invariant (CRLF input hashes like LF)', () => {
    const crlf = DIGEST_BODY.replace(/\n/g, '\r\n');
    expect(digestSha256(crlf)).toBe(digestSha256(DIGEST_BODY));
  });

  it('anchor round-trips through ANCHOR_RE', () => {
    const anchor = digestAnchor('9.9.9');
    const m = anchor.match(ANCHOR_RE);
    expect(m?.groups?.cli).toBe('9.9.9');
    expect(m?.groups?.sha256).toBe(digestSha256(DIGEST_BODY));
  });

  it('digestBlockBody = anchor line + body', () => {
    const block = digestBlockBody('1.0.0');
    const [first, ...rest] = block.split('\n');
    expect(first).toBe(digestAnchor('1.0.0'));
    expect(rest.join('\n')).toBe(DIGEST_BODY);
  });
});
