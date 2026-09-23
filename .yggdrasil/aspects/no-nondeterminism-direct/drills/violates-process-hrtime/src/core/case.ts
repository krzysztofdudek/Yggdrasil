export function tick(): bigint {
  return process.hrtime.bigint();
}
