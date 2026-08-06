// A rule with no owning component that lists a permitted directory. The
// listing is raw and unfiltered, and the whole listing is remembered — adding
// or renaming ANY file in the directory makes the result need re-checking,
// even a file the rule could never itself read.
export function check(ctx) {
  const entries = ctx.fs.list('src/helper');
  return entries.length > 0 ? [] : [{ message: 'directory listing was empty' }];
}
