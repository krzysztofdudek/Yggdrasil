export function check(ctx) {
  return ctx.files.map((f) => ({ file: f.path, message: 'checked' }));
}
