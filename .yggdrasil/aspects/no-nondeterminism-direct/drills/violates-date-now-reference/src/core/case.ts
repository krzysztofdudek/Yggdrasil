export function clockFrom(opts: { now?: () => number }): () => number {
  return opts.now ?? Date.now.bind(Date);
}
