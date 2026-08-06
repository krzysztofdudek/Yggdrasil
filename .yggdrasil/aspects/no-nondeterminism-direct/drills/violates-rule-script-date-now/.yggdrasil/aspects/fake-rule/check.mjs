export function check(ctx) {
  const stamp = Date.now();
  return ctx.files.map((f) => ({ file: f.path, message: `stamped at ${stamp}` }));
}
