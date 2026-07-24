import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, statSync, existsSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startServer, type ServerHandle } from '../../src/portal/server/server.js';
import { parseDryRunBudget } from '../../src/portal/server/approve.js';
import { runCheck } from '../../src/core/check.js';
import { loadGraph } from '../../src/core/graph-loader.js';
import { walkRepoFiles } from '../../src/io/repo-scanner.js';
import { readRulesArtifacts } from '../../src/cli/rules-artifacts.js';
import type { PortalData } from '../../src/portal/contract.js';

interface DryRunBody {
  pairs: number;
  deterministic: number;
  reviewerCalls: number;
  raw: string;
}
interface ApproveBody {
  ok: boolean;
  exitCode: number;
  stdout?: string;
  stderr?: string;
}
interface ViewOnlyBody {
  error: string;
  message?: string;
}

// Integration test for the loopback portal server (Phase 2.1–2.3). Starts the REAL server
// in-process against the REAL portal-basic fixture project (a real .yggdrasil/ graph + real
// source), then drives it with a real HTTP client (fetch). No mocking. The approve / dry-run
// shells re-enter the real dist/bin.js (resolved by the server's bin resolver), so they are
// exercised end-to-end against the actual CLI — the deterministic path is free and keyless.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(CLI_ROOT, 'tests', 'fixtures', 'portal-basic');

// The portal page attaches a marker header to every /data, /approve/dry-run and /approve call;
// the server refuses a guarded request that lacks it (cross-origin / CSRF guard). These
// functional tests simulate the page, so they send it via apiFetch. The dedicated guard block
// below drives raw HTTP (node:http, unlike fetch, does NOT strip the forbidden Origin/Host
// headers) to prove the refusal path.
function apiFetch(url: string, init: Record<string, unknown> = {}) {
  const headers = { ...(init.headers as Record<string, string> | undefined), 'x-yg-portal': '1' };
  return fetch(url, { ...init, headers } as Parameters<typeof fetch>[1]);
}

/** Issue a raw HTTP request with EXACT headers (needed to set Origin/Host, which fetch strips). */
function rawRequest(
  urlStr: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Copy the fixture into a fresh temp dir so a real approve never mutates the committed fixture. */
function freshFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-portal-server-int-'));
  tmpDirs.push(dir);
  const dest = path.join(dir, 'project');
  cpSync(FIXTURE_ROOT, dest, { recursive: true });
  const detCache = path.join(dest, '.yggdrasil', '.yg-lock.deterministic.json');
  if (existsSync(detCache)) rmSync(detCache, { force: true });
  return dest;
}

/** Read the bytes + mtime of every lock-ish file under a project's .yggdrasil/. */
function lockSnapshot(projectRoot: string): Map<string, { bytes: string; mtimeMs: number }> {
  const ygDir = path.join(projectRoot, '.yggdrasil');
  const names = ['yg-lock.nondeterministic.json', 'yg-lock.logs.json', '.yg-lock.deterministic.json'];
  const snap = new Map<string, { bytes: string; mtimeMs: number }>();
  for (const name of names) {
    const p = path.join(ygDir, name);
    if (existsSync(p)) snap.set(name, { bytes: readFileSync(p, 'utf-8'), mtimeMs: statSync(p).mtimeMs });
    else snap.set(name, { bytes: '<absent>', mtimeMs: 0 });
  }
  return snap;
}

describe('portal loopback server — read-only surface + no-persist refresh', () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    // port 0 → ephemeral, collision-free. Read-only routes only here, so FIXTURE_ROOT is safe.
    handle = await startServer({ projectRoot: FIXTURE_ROOT, port: 0, writeEnabled: true });
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  it('binds the loopback interface only (127.0.0.1)', () => {
    expect(handle.url.startsWith('http://127.0.0.1:')).toBe(true);
    expect(handle.port).toBeGreaterThan(0);
  });

  it('GET / serves the instant loading shell that boots the full page from /render', async () => {
    const res = await fetch(`${handle.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
    // The shell is instant + self-contained: it carries NO inlined portal data (that
    // is the heavy /render payload) and boots the real page by fetching /render.
    expect((html.match(/<script id="portal-data" type="application\/json">/g) ?? []).length).toBe(0);
    expect(html).toContain('/render');
    expect(html).toContain('yg-boot'); // the loading-shell container
  });

  it('GET /render serves the self-contained portal page with the inlined live data', async () => {
    const res = await fetch(`${handle.url}/render`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect((html.match(/<script id="portal-data" type="application\/json">/g) ?? []).length).toBe(1);
  });

  it('GET /data returns valid PortalData whose counts equal yg check', async () => {
    const res = await apiFetch(`${handle.url}/data`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const data = (await res.json()) as PortalData;

    const graph = await loadGraph(FIXTURE_ROOT);
    const gitFiles = await walkRepoFiles(FIXTURE_ROOT);
    // The oracle is the CLI BOUNDARY's option set, not a bare runCheck: core skips a
    // boundary-injected check when its input is absent, so an oracle that omits an input
    // the CLI passes would agree with a portal that omits it too — both at zero — and the
    // "portal shows fewer warnings than the command line" class would slip through. This
    // fixture ships no agent-rules install, so the digest gate has a real finding to make.
    const check = await runCheck(graph, gitFiles, {
      nowUtc: () => new Date(),
      rulesArtifacts: await readRulesArtifacts(FIXTURE_ROOT),
    });
    const errors = check.issues.filter((i) => i.severity === 'error').length;
    const warnings = check.issues.filter((i) => i.severity === 'warning').length;

    expect(data.meta.counts.errors).toBe(errors);
    expect(data.meta.counts.warnings).toBe(warnings);
    expect(data.meta.counts.coveredFiles).toBe(check.coveredFiles);
    expect(data.meta.counts.totalFiles).toBe(check.totalFiles);
    expect(data.meta.counts.nodes).toBe(graph.nodes.size);
    // meta surfaces auto_approve + writeEnabled + a freshness stamp.
    expect(['false', 'deterministic', 'full']).toContain(data.meta.autoApprove);
    expect(data.meta.writeEnabled).toBe(true);
    expect(Number.isNaN(Date.parse(data.meta.generatedAt))).toBe(false);
  }, 60_000);

  it('repeated GET /data writes NOTHING — committed lock + det cache byte-unchanged', async () => {
    const before = lockSnapshot(FIXTURE_ROOT);
    await (await apiFetch(`${handle.url}/data`)).json();
    await (await apiFetch(`${handle.url}/data`)).json();
    await (await apiFetch(`${handle.url}/data`)).json();
    const after = lockSnapshot(FIXTURE_ROOT);
    for (const [name, b] of before) {
      const a = after.get(name)!;
      expect(a.bytes, `lock file ${name} bytes changed across refresh`).toBe(b.bytes);
      expect(a.mtimeMs, `lock file ${name} mtime changed across refresh`).toBe(b.mtimeMs);
    }
  }, 60_000);

  it('successive refreshes report identical counts (deterministic, stable)', async () => {
    const a = (await (await apiFetch(`${handle.url}/data`)).json()) as PortalData;
    const b = (await (await apiFetch(`${handle.url}/data`)).json()) as PortalData;
    expect(a.meta.counts).toEqual(b.meta.counts);
  }, 60_000);

  it('GET /static/* serves a committed frontend asset', async () => {
    const res = await fetch(`${handle.url}/static/app.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
    const css = await res.text();
    expect(css.length).toBeGreaterThan(0);
  });

  it('GET /static/* rejects path traversal outside the asset tree (404, never serves source)', async () => {
    const res = await fetch(`${handle.url}/static/%2e%2e/%2e%2e/serializer.ts`);
    expect(res.status).toBe(404);
  });

  it('GET /static/<missing> is a 404', async () => {
    const res = await fetch(`${handle.url}/static/nope.css`);
    expect(res.status).toBe(404);
  });

  it('an unknown route is a 404, never a silent 200', async () => {
    const res = await fetch(`${handle.url}/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('an unknown POST route is a 404', async () => {
    const res = await fetch(`${handle.url}/nope`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('portal loopback server — cross-origin / CSRF guard on the sensitive routes', () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    // A 403 refusal never reaches the engine and never writes, so the committed fixture is safe.
    handle = await startServer({ projectRoot: FIXTURE_ROOT, port: 0, writeEnabled: true });
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  it('a guarded request WITHOUT the portal marker header is refused 403 (a forged cross-site call cannot set it)', async () => {
    const post = await rawRequest(`${handle.url}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llm: false }),
    });
    expect(post.status).toBe(403);
    expect((JSON.parse(post.body) as { error: string }).error).toBe('forbidden-cross-origin');
    expect((await rawRequest(`${handle.url}/data`, {})).status).toBe(403);
    expect((await rawRequest(`${handle.url}/approve/dry-run?llm=false`, {})).status).toBe(403);
  });

  it('a cross-origin Origin is refused even WITH the marker header (defense in depth)', async () => {
    const res = await rawRequest(`${handle.url}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yg-portal': '1', origin: 'https://evil.example' },
      body: JSON.stringify({ llm: false }),
    });
    expect(res.status).toBe(403);
  });

  it('a non-loopback Host is refused even WITH the marker header (DNS-rebinding guard)', async () => {
    const res = await rawRequest(`${handle.url}/data`, {
      headers: { 'x-yg-portal': '1', host: 'evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('the marker header + loopback Host passes the guard — the portal page path is never blocked', async () => {
    const ok = await rawRequest(`${handle.url}/data`, { headers: { 'x-yg-portal': '1' } });
    expect(ok.status).toBe(200);
  }, 60_000);

  it('the un-guarded HTML page routes need no marker (a browser navigates them directly)', async () => {
    expect((await rawRequest(`${handle.url}/`, {})).status).toBe(200);
    expect((await rawRequest(`${handle.url}/render`, {})).status).toBe(200);
  }, 60_000);
});

describe('portal loopback server — view-only mode rejects the write', () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    handle = await startServer({ projectRoot: FIXTURE_ROOT, port: 0, writeEnabled: false });
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  it('POST /approve is rejected 409 in view-only (--no-write) mode', async () => {
    const res = await apiFetch(`${handle.url}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llm: false }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ViewOnlyBody;
    expect(body.error).toBe('view-only');
  });

  it('GET /data still works in view-only mode and reflects writeEnabled:false', async () => {
    const res = await apiFetch(`${handle.url}/data`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as PortalData;
    expect(data.meta.writeEnabled).toBe(false);
  }, 60_000);

  it('view-only refresh still writes nothing to the lock', async () => {
    const before = lockSnapshot(FIXTURE_ROOT);
    await (await apiFetch(`${handle.url}/data`)).json();
    const after = lockSnapshot(FIXTURE_ROOT);
    for (const [name, b] of before) {
      expect(after.get(name)!.bytes).toBe(b.bytes);
    }
  }, 60_000);
});

describe('portal loopback server — dry-run preview + the one Approve write (temp fixture)', () => {
  let handle: ServerHandle;
  let projectRoot: string;

  beforeAll(async () => {
    // A temp COPY: the real Approve writes the deterministic cache — never the committed fixture.
    projectRoot = freshFixture();
    handle = await startServer({ projectRoot, port: 0, writeEnabled: true });
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  it('GET /approve/dry-run returns the engine budget preview (free det path, llm=false)', async () => {
    const res = await apiFetch(`${handle.url}/approve/dry-run?llm=false`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DryRunBody;
    expect(typeof body.pairs).toBe('number');
    expect(typeof body.deterministic).toBe('number');
    expect(body.reviewerCalls).toBe(0); // llm=false → free, keyless path
    expect(body.raw).toContain('reviewer calls');
  }, 60_000);

  it('GET /approve/dry-run defaults the LLM checkbox on when llm param is absent', async () => {
    const res = await apiFetch(`${handle.url}/approve/dry-run`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DryRunBody;
    expect(typeof body.pairs).toBe('number');
  }, 60_000);

  it('a real POST /approve {llm:false} runs the deterministic fill; next /data reflects it (no committed write)', async () => {
    const ygDir = path.join(projectRoot, '.yggdrasil');
    const committedLock = path.join(ygDir, 'yg-lock.nondeterministic.json');
    const committedBefore = existsSync(committedLock) ? readFileSync(committedLock, 'utf-8') : null;

    const res = await apiFetch(`${handle.url}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llm: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApproveBody;
    expect(body.ok).toBe(true);
    expect(body.exitCode).toBe(0);

    // The deterministic cache now exists (the fill genuinely ran via the spawned CLI)...
    expect(existsSync(path.join(ygDir, '.yg-lock.deterministic.json'))).toBe(true);
    // ...and the committed lock is byte-unchanged (deterministic approve never touches it).
    if (committedBefore !== null) {
      expect(readFileSync(committedLock, 'utf-8')).toBe(committedBefore);
    }

    // The next /data reflects post-approve truth — re-derived live, never a silent success.
    const after = (await (await apiFetch(`${handle.url}/data`)).json()) as PortalData;
    expect(after.meta.counts.unverified).toBe(0);
    expect(after.meta.counts.refused).toBe(0);
    expect(after.meta.counts.errors).toBe(0);
  }, 120_000);

  it('POST /approve with an empty body is accepted (LLM checkbox defaults on) and returns a structured result', async () => {
    // After the prior deterministic approve everything is already verified, so a full
    // --approve fills nothing and returns cleanly — exercising the empty-body default path.
    const res = await apiFetch(`${handle.url}/approve`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApproveBody;
    expect(body).toHaveProperty('exitCode');
    expect(body).toHaveProperty('ok');
  }, 120_000);

  it('POST /approve with a non-JSON body is tolerated (parse falls back, write still runs)', async () => {
    // An unparseable body falls back to {} → the LLM checkbox defaults on → a clean full
    // --approve (everything already verified) — exercising the body-parse fallback path.
    const res = await apiFetch(`${handle.url}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json {',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApproveBody;
    expect(body).toHaveProperty('exitCode');
  }, 120_000);

  it('POST /approve with a non-object JSON body (e.g. true) falls back to defaults and still runs', async () => {
    // Valid JSON that is not an object → the body-shape guard returns {} → LLM defaults on.
    const res = await apiFetch(`${handle.url}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'true',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApproveBody;
    expect(body).toHaveProperty('exitCode');
  }, 120_000);
});

describe('portal loopback server — handler error surfaces as a structured 500 (never a silent 200)', () => {
  let handle: ServerHandle;
  let bogusRoot: string;

  beforeAll(async () => {
    // A temp dir with NO .yggdrasil/ graph: extractPortalData throws → the router must
    // surface a structured 500, never a silent success.
    bogusRoot = mkdtempSync(path.join(tmpdir(), 'yg-portal-bogus-'));
    tmpDirs.push(bogusRoot);
    handle = await startServer({ projectRoot: bogusRoot, port: 0, writeEnabled: true });
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  it('GET /data on a project with no graph returns a structured 500', async () => {
    const res = await apiFetch(`${handle.url}/data`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('internal');
    expect(typeof body.message).toBe('string');
  }, 60_000);

  it('GET /render on a project with no graph returns a human-readable HTML error page (not raw JSON)', async () => {
    const res = await fetch(`${handle.url}/render`);
    expect(res.status).toBe(500);
    // A person navigated here — surface a readable page, not a JSON blob.
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(html).toMatch(/could ?n.?t|unable|problem|went wrong/i);
    expect(html).not.toContain('{"error"'); // never the raw JSON shape
  }, 60_000);

  it('GET / still serves the instant loading shell even when the graph is broken', async () => {
    const res = await fetch(`${handle.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('yg-boot');
  }, 60_000);
});

describe('portal loopback server — startServer rejects on a bind failure (port in use)', () => {
  it('a second bind on the same port rejects (the listen error path is surfaced, not swallowed)', async () => {
    // Bind an ephemeral port, then try to bind the SAME port again: the second listen emits
    // an EADDRINUSE error, which startServer must surface as a rejected promise (never hang).
    const first = await startServer({ projectRoot: FIXTURE_ROOT, port: 0, writeEnabled: false });
    try {
      await expect(
        startServer({ projectRoot: FIXTURE_ROOT, port: first.port, writeEnabled: false }),
      ).rejects.toThrow();
    } finally {
      await first.close();
    }
  }, 60_000);
});

// ── parseDryRunBudget — pure parse of the CLI's budget header (direct unit coverage) ──
describe('parseDryRunBudget — the engine budget header parse', () => {
  it('parses the pairs / deterministic / reviewer-call counts and the raw line', () => {
    const out =
      'Filling 5 unverified pairs across 3 nodes — 2 deterministic (no cost), 7 reviewer calls (consensus included)\n' +
      'more text below';
    const p = parseDryRunBudget(out);
    expect(p.pairs).toBe(5);
    expect(p.deterministic).toBe(2);
    expect(p.reviewerCalls).toBe(7);
    expect(p.raw).toContain('5 unverified pairs');
  });

  it('throws when the budget header is absent (a dry-run always emits it)', () => {
    expect(() => parseDryRunBudget('no budget here')).toThrow(/Could not parse/);
  });
});
