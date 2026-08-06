// Downloads a remote font manifest; falls back to an empty list on any network failure.
export async function loadFontManifest(url: string, fetchImpl: typeof fetch): Promise<string[]> {
  try {
    const res = await fetchImpl(url);
    return (await res.json()) as string[];
  } catch {
    return [];
  }
}
