// Downloads a remote font manifest; falls back to an empty list on any network failure.
import { debugWrite } from '../utils/debug-log.js';

export async function loadFontManifest(url: string, fetchImpl: typeof fetch): Promise<string[]> {
  try {
    const res = await fetchImpl(url);
    return (await res.json()) as string[];
  } catch (e) {
    debugWrite(`[fonts] loadFontManifest: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
