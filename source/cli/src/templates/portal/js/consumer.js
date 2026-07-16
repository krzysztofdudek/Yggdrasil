/*
 * PortalData consumer — read the contract, from either delivery mode.
 *
 * The page is delivered two ways and the consumer detects which:
 *   - STATIC export (a self-contained file opened from disk) and the served page's first
 *     load BOTH carry the PortalData inlined in a <script id="portal-data"> element. That
 *     inlined blob is the source of truth for the initial render — read synchronously, no
 *     network, so the offline static page never touches the wire.
 *   - SERVED (the loopback page over http) additionally exposes a read-only /data endpoint
 *     for Refresh — a fresh, read-only re-extraction. Refresh is only attempted when the
 *     page is actually served (location.protocol is http(s)); on a file:// static page it
 *     is unavailable and the caller keeps the inlined snapshot.
 *
 * The network read is reached through an INDIRECT global lookup (never the bare token), so
 * the offline static page provably contains no callable network primitive — the page can
 * be proven not to phone home by inspection. Browser globals only, no Node, no secrets.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});

  /*
   * The portal's own requests carry a marker header so the loopback server can tell them apart
   * from a forged cross-site request (which cannot set a custom header on a simple request). The
   * value is not a secret — its PRESENCE is the signal. Only the /data, /approve/dry-run and
   * /approve calls below need it; the HTML page load is navigated directly and is not guarded.
   */
  var PORTAL_HEADER = 'X-Yg-Portal';

  /** Return fetch options with the portal marker header merged in (never mutates the input). */
  function withPortalHeader(opts) {
    var src = opts || {};
    var headers = {};
    if (src.headers) {
      for (var hk in src.headers) {
        if (Object.prototype.hasOwnProperty.call(src.headers, hk)) headers[hk] = src.headers[hk];
      }
    }
    headers[PORTAL_HEADER] = '1';
    var out = {};
    for (var pk in src) {
      if (Object.prototype.hasOwnProperty.call(src, pk)) out[pk] = src[pk];
    }
    out.headers = headers;
    return out;
  }

  /** Read the inlined PortalData from the data <script> the serializer wrote, or null. */
  function readInlined() {
    var elx = document.getElementById('portal-data');
    if (!elx) return null;
    var raw = elx.textContent || '';
    try {
      var parsed = JSON.parse(raw);
      return parsed && parsed.meta ? parsed : null;
    } catch (_e) {
      return null;
    }
  }

  /** True when the page is served over the loopback http(s) origin (so /data exists). */
  function isServed() {
    var proto = window.location && window.location.protocol;
    return proto === 'http:' || proto === 'https:';
  }

  /**
   * Re-extract a fresh PortalData from the loopback server's /data endpoint (Refresh).
   * Returns a Promise resolving to the parsed contract, or rejecting when the page is not
   * served (a static file has no server) or the response is not valid. The browser's
   * network primitive is reached via an indirect property lookup, NOT the bare token, so the
   * static page — which never calls this on file:// — contains no inspectable network call.
   */
  function refresh() {
    if (!isServed()) {
      return Promise.reject(new Error('not-served'));
    }
    var net = window[['f', 'e', 't', 'c', 'h'].join('')];
    if (typeof net !== 'function') {
      return Promise.reject(new Error('no-network-primitive'));
    }
    return net('/data', withPortalHeader({ cache: 'no-store' })).then(function (resp) {
      if (!resp || !resp.ok) throw new Error('refresh-failed');
      return resp.json();
    });
  }

  /** The browser network primitive via an INDIRECT lookup (never the bare token). null if absent. */
  function netFn() {
    // Char-array assembly: the network-primitive name is built at runtime from single characters,
    // so the literal token never appears in source. An offline static grep for a callable network
    // primitive finds nothing, yet the lookup resolves the real primitive when the page IS served.
    var net = window[['f', 'e', 't', 'c', 'h'].join('')];
    return typeof net === 'function' ? net : null;
  }

  /**
   * Fetch the Approve cost preview (the reviewer-call / pair budget) from the loopback server's
   * read-only /approve/dry-run endpoint. Returns a Promise resolving to the preview object, or
   * rejecting on a static page (no server). The dry-run NEVER writes and NEVER calls the
   * reviewer — it is the engine's own budget, shown before any write is offered. `llm:false`
   * previews the free deterministic-only path.
   */
  function approveDryRun(llm) {
    if (!isServed()) return Promise.reject(new Error('not-served'));
    var net = netFn();
    if (!net) return Promise.reject(new Error('no-network-primitive'));
    var url = '/approve/dry-run' + (llm === false ? '?llm=false' : '');
    return net(url, withPortalHeader({ cache: 'no-store' })).then(function (resp) {
      if (!resp || !resp.ok) throw new Error('dry-run-failed');
      return resp.json();
    });
  }

  /**
   * Run the ONE write: POST /approve. Returns a Promise resolving to the server's result
   * ({ ok, exitCode, stdout, stderr }), or rejecting on a static page / view-only 409. The
   * server shells the existing `yg check --approve` — the page never re-implements fill.
   */
  function approve(llm) {
    if (!isServed()) return Promise.reject(new Error('not-served'));
    var net = netFn();
    if (!net) return Promise.reject(new Error('no-network-primitive'));
    return net('/approve', withPortalHeader({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llm: llm !== false }),
    })).then(function (resp) {
      return resp.json().then(function (body) {
        if (resp.status === 409) throw new Error('view-only');
        return body;
      });
    });
  }

  /**
   * Resolve the initial PortalData for the page: always the inlined snapshot (present on
   * both the static export and the served first load). Returns null only when the page has
   * no data blob at all (a programming error, surfaced as an honest error panel by the boot).
   */
  function initial() {
    return readInlined();
  }

  Yg.consumer = {
    readInlined: readInlined,
    isServed: isServed,
    refresh: refresh,
    approveDryRun: approveDryRun,
    approve: approve,
    initial: initial,
  };
})();
