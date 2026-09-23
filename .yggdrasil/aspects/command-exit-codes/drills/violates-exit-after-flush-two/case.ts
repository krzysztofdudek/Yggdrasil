export async function run(exitAfterFlush: (code: number) => Promise<void>): Promise<void> {
  await exitAfterFlush(2);
}
