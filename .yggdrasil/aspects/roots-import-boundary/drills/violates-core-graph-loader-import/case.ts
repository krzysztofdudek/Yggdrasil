import { loadGraph } from '../core/graph-loader.js';

export async function loadForRoots(root: string) {
  return loadGraph(root);
}
