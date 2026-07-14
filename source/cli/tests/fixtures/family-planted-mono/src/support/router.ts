export function route(method: string, path: string): number {
  if (method === "GET") {
    return 1;
  } else if (method === "POST") {
    return 2;
  }
  for (let i = 0; i < 3; i++) {
    if (path.length > i) {
      return i;
    }
  }
  return 0;
}
