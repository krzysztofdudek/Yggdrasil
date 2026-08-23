export async function loadForRoots(root: string) {
  const { loadGraph } = await import('../core/graph-loader.js');
  return loadGraph(root);
}
