## [2026-07-28T13:55:59.258Z]
New file created by splitting the check command's output rendering into single-responsibility modules — this one owns view selection (--summary/--top/--aspect/details/full) and composes the header and group renderers, with no behavior change from the code it was cut from.
