## [2026-06-29T06:49:44.331Z]
Introduce the loopback read-only HTTP server for the portal. It binds the local loopback interface only (never an exposed interface) so the portal is reachable strictly from the same machine, and returns a teardownable handle so it can always be stopped cleanly (important for automated tests and for releasing the port on interrupt). It serves the live page, a fresh read-only re-extraction of the portal data on every refresh that persists nothing, the committed frontend assets through a path-safe reader, a cost preview, and one write action. The single write — Approve — is performed by shelling out to the existing command-line tool as a child process rather than re-implementing the fill in-process: this keeps secret/key handling entirely inside the tool the server launches, so the server itself never reads secrets and never holds a lock writer. A view-only mode disables the write entirely and rejects an approve attempt, for shared or wall-board deployments where the page must never trigger a write.
## [2026-07-02T07:24:23.944Z]
The root route did all the heavy graph reading and page assembly before sending any bytes, so a browser waited on a blank page and any failure surfaced as a raw machine-readable error. Serving is now split: the root responds instantly with a loading indicator that then fetches the full page and swaps it into the document, keeping the address unchanged so a directly-opened deep view still resolves; and a failed full-page render returns a readable error page rather than a raw error blob, because a person navigated there. Interactive data and action endpoints keep returning machine-readable responses, since those are consumed by scripts rather than read by a person.
## [2026-07-02T08:05:18.339Z]
The instant loading page and the readable render-failure page now live in their own focused file in the server layer instead of being imported from the static-export serializer. They are inherently live-server responses (sent by the entry route and the render route) and read nothing from disk, so they belong beside the routes that send them rather than in the offline-export path. No behaviour change; only where the two page builders live.
## [2026-07-02T13:09:57.722Z]
Stop the loopback HTTP server from returning raw internal error detail in the body of its data responses. When a request handler throws, the caught error text can carry absolute filesystem paths and stack frames. This tool is run by many people, and even though the server binds only to the local loopback address, on a shared host that address is reachable by other local accounts — so internal detail must not travel over the HTTP response.

### What changed in behavior
The failure response now returns a generic message, and the full technical reason is written to the terminal that runs the portal — a channel visible only to the process owner. The operator keeps full debuggability (the real cause is on their terminal, where the error page already directs them), while the wire no longer carries internal paths or stack detail. The human-readable HTML error page for a failed top-level render is unchanged; this concerns the machine-readable data-endpoint responses.
## [2026-07-16T12:58:03.595Z]
Guard the portal's local web view against cross-site request forgery.

The portal's sensitive routes — the one write (Approve) and the read-only
data and cost-preview fetches — were answered for any request that reached
the loopback port. A browser will SEND a cross-site request to a loopback
address even though it cannot READ the response, so a malicious page a person
happened to open in another tab could silently trigger the Approve write (or
repeatedly spawn the preview subprocess) without the operator's knowledge or
intent. Binding to the loopback interface alone does not prevent this: the
request originates from the operator's own browser, which can always reach the
loopback address.

The defense requires the portal's own page to prove that each sensitive
request came from itself. The page attaches a custom marker header that a
cross-site "simple" request cannot set, and the server refuses any sensitive
request that lacks it; because the server also returns no permissive
cross-origin response header, a pre-flighted forgery cannot succeed either.
As defense in depth the server additionally rejects a request whose stated
origin is a different site, or whose Host header is not a loopback literal —
the latter blocking a DNS-rebinding attempt that reaches the loopback server
under an attacker-controlled hostname. The plain page and static-asset routes
are deliberately left unguarded, because a browser navigates to them directly
and cannot attach a custom header; those routes perform no action and reveal
only the same page a local operator already sees.
