## [2026-07-28T13:55:59.258Z]
New file created by splitting the check command's output rendering into single-responsibility modules — this one owns view selection (--summary/--top/--aspect/details/full) and composes the header and group renderers, with no behavior change from the code it was cut from.
## [2026-08-03T08:01:05.549Z]
The Next: line's residual annotation now excludes a pair this same run's fill already proved cannot run from the count it promises --approve will fill, folding it into the errors-remaining count instead. Before this, an unverified pair that could never be filled was still counted as something --approve would fill, so the footer promised progress a re-run could never deliver for that pair.
