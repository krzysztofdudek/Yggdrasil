## [2026-06-13T03:12:07.687Z]
Producer and verifier must fold byte-identical hash ingredients or every recorded verdict would read as unverified, so the ingredient assembly lives in one shared place that both the fill stage and the check stage call, with each side owning only its own read-failure policy.
## [2026-06-16T09:52:38.429Z]
Same contract as the hash core: the tier hash view folds only the tier NAME. The resolved tier configuration is not a judgment input, so swapping the model or provider behind a named tier does not invalidate recorded verdicts.
## [2026-06-19T19:19:17.425Z]
Derive the resolver-source fingerprint from the loaded aspect so the review producer and the verifier compute the paired-review identity from one shared definition and can never disagree, which would otherwise pin every paired verdict to a permanent unverified state.
## [2026-07-28T19:45:51.929Z]
The node-description helper now answers safely when there is no owning component (a file enforced by its architecture type alone) instead of assuming one always exists.
## [2026-07-30T19:19:39.512Z]
Comment text referenced a planning label that only makes sense with access to material outside the repository, which conflicts with this project's own rule that a source comment must stand on its own. Reworded the affected comment to state what the code does and why in its own terms; no behavior changed.
## [2026-08-07T11:03:20.529Z]
The helper that read a component's description for the prompt is gone, along with the description's presence in the prompt. Every ingredient a prompt is assembled from is now folded into the verdict hash; leaving the helper exported would have left a way for a future caller to reintroduce the one asymmetry that made a prompt's size unpredictable from its verdict.
