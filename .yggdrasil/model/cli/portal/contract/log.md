## [2026-08-03T12:48:16.319Z]
PortalTypeCoveredFile.unverified's doc corrected: it is read straight off the full lock re-verification the pipeline already computes, not a separate presence-only check, so it now catches a stale recorded verdict on a nodeless pair too, not only a missing one -- it can no longer read false for a file yg check would call unverified.
