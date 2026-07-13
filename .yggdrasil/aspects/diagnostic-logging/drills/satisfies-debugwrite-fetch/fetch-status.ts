// Fetches a remote status, falling back to a cached value when the request fails.
import { debugWrite } from '../utils/debug-log.js';

interface Status {
  ok: boolean;
}

async function requestStatus(url: string): Promise<Status> {
  const res = await fetch(url);
  return (await res.json()) as Status;
}

function cachedStatus(): Status {
  return { ok: false };
}

export async function getStatusOrCached(url: string): Promise<Status> {
  try {
    return await requestStatus(url);
  } catch (error) {
    debugWrite(`[status] getStatusOrCached: ${(error as Error).message}`);
    return cachedStatus();
  }
}
