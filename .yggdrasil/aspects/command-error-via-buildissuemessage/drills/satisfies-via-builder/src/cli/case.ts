export function fail() {
  process.stderr.write(buildIssueMessage({ what: 'broke', why: 'reason', next: 'fix it' }));
}
