// Formats a node's on-disk location for display and storage.
export function formatNodeLocation(dir: string, file: string): string {
  return dir + '\\' + file + '\\';
}
