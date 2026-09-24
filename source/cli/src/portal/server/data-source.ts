import { extractPortalData } from '../extract.js';
import { portalStateKey } from '../state-key.js';
import type { PortalData } from '../contract.js';

/**
 * server/data-source — one extraction of PortalData shared by every request that
 * asks while it runs, and reused until the project changes.
 *
 * An extraction re-derives the whole project (the graph, the lock, a check run),
 * which on a large repository takes around a minute. Before this, every `/render`
 * and `/data` request ran its own: a page load plus a refresh click ran two in
 * parallel, and each took longer for the other. Now concurrent requests wait on
 * the one in flight, and a request that finds the project unchanged since the
 * last extraction gets that result back.
 *
 * "Unchanged" is the project state key (portal/state-key.ts): the HEAD commit,
 * the changed and untracked files with their sizes and modification times, and
 * the local deterministic cache. When no key can be taken — no git, git failing
 * — nothing is reused; requests are still coalesced.
 */

export interface PortalDataSource {
  /** Fresh-as-the-project PortalData: shared with a request already extracting, or reused when nothing changed. */
  get(): Promise<PortalData>;
}

export interface PortalDataSourceDeps {
  extract?: (projectRoot: string, opts: { writeEnabled: boolean }) => Promise<PortalData>;
  fingerprint?: (projectRoot: string) => Promise<string | null>;
}

export function createPortalDataSource(
  projectRoot: string,
  writeEnabled: boolean,
  deps: PortalDataSourceDeps = {},
): PortalDataSource {
  const extract = deps.extract ?? extractPortalData;
  const fingerprint = deps.fingerprint ?? portalStateKey;
  let cached: { key: string; data: PortalData } | undefined;
  let inflight: { key: string | null; promise: Promise<PortalData> } | undefined;

  return {
    async get(): Promise<PortalData> {
      const key = await fingerprint(projectRoot);
      if (key !== null && cached?.key === key) return cached.data;
      // Join the extraction already running unless it started from a project
      // state this request knows to be different.
      if (inflight && (key === null || inflight.key === null || inflight.key === key)) return inflight.promise;
      const run = { key, promise: extract(projectRoot, { writeEnabled }) };
      inflight = run;
      try {
        const data = await run.promise;
        if (key !== null) cached = { key, data };
        return data;
      } finally {
        if (inflight === run) inflight = undefined;
      }
    },
  };
}
