export function boot(root) {
  return loadGraph(root, { noSecrets: true });
}
