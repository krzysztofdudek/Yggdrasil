export async function readOr(p, fallback) {
  try {
    return await readFile(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}
