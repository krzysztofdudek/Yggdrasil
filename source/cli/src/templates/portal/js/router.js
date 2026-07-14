/*
 * URL-hash router — the deep-link grammar for every view and entity.
 *
 * The portal is a single page, but EVERY view and EVERY entity (node / aspect / flow,
 * down to a per-verdict node→aspect→file-unit) is deep-linkable: a hash routes straight
 * to it, and reloading the page reopens exactly what the hash names (an entity reopens
 * its panel). The grammar:
 *
 *   (empty)                                  -> { view: 'overview' }            (default)
 *   #/view/<viewId>                          -> { view: <viewId> }
 *   #/node/<path>                            -> { view: 'tree',  node: <path> }
 *   #/node/<path>/<aspectId>/<file-unit>     -> { ..., aspect, file }          (per-verdict)
 *   #/aspect/<id>                            -> { view: 'rulebook', aspect: <id> }
 *   #/flow/<name>                            -> { view: 'flows', flow: <name> }
 *
 * Each path segment is percent-encoded, so a node path with slashes, or a file unit with
 * its own slashes, round-trips losslessly. parse() and serialize() are PURE string
 * functions (no DOM, no window) so they are testable directly; start() wires them to the
 * live `hashchange` event. Browser globals only — no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});

  // The known full-view ids. An unknown view id falls back to the overview so a stale or
  // hand-typed hash never lands on a blank page.
  var VIEWS = [
    'overview',
    'coverage',
    'tree',
    'relations',
    'structure',
    'rulebook',
    'types',
    'flows',
    'suppressions',
    'start',
  ];

  // Which view an entity kind opens into (the entity's natural home surface).
  var ENTITY_VIEW = { node: 'tree', aspect: 'rulebook', flow: 'flows' };

  function isKnownView(id) {
    return VIEWS.indexOf(id) !== -1;
  }

  /** Split a hash into clean, decoded segments (drops the leading '#', '/' and empties). */
  function segments(hash) {
    var raw = String(hash || '');
    if (raw.charAt(0) === '#') raw = raw.slice(1);
    if (raw.charAt(0) === '/') raw = raw.slice(1);
    if (raw.length === 0) return [];
    return raw.split('/').map(decodeSegment);
  }

  function decodeSegment(seg) {
    try {
      return decodeURIComponent(seg);
    } catch (_e) {
      return seg;
    }
  }

  /**
   * Parse a hash string into a normalized route object. Always returns a valid route — an
   * empty or malformed hash resolves to the default overview, never null. The route always
   * carries a `view`; entity fields (node / aspect / flow / file) are present only when the
   * hash names them.
   */
  function parse(hash) {
    var segs = segments(hash);
    if (segs.length === 0) return { view: 'overview' };

    var kind = segs[0];

    if (kind === 'view') {
      var id = segs[1];
      if (isKnownView(id)) return { view: id };
      return { view: 'overview', notFound: id || '(none)' };
    }

    if (kind === 'node' && segs[1]) {
      var route = { view: ENTITY_VIEW.node, node: segs[1] };
      // Per-verdict file unit: node / aspectId / file-unit (file may itself contain '/').
      if (segs.length >= 4) {
        route.aspect = segs[2];
        route.file = segs.slice(3).join('/');
      }
      return route;
    }

    if (kind === 'aspect' && segs[1]) {
      return { view: ENTITY_VIEW.aspect, aspect: segs[1] };
    }

    if (kind === 'flow' && segs[1]) {
      return { view: ENTITY_VIEW.flow, flow: segs[1] };
    }

    // Bare `#/view-id` shorthand (no `view/` prefix) — accept a known view id directly.
    if (isKnownView(kind)) return { view: kind };

    // An unrecognized hash — degrade to overview but carry the requested token so the page can
    // say "nothing here" honestly, instead of silently presenting overview as if it resolved.
    return { view: 'overview', notFound: segs.join('/') };
  }

  function enc(seg) {
    return encodeURIComponent(String(seg));
  }

  /**
   * Serialize a route object back into a canonical hash string. The inverse of parse for
   * any route parse() produces, so a round-trip is lossless. A node route with a per-verdict
   * file unit encodes node / aspect / file as separate segments (the file's own slashes are
   * percent-encoded inside its single segment).
   */
  function serialize(route) {
    if (!route || !route.view) return '#/view/overview';

    if (route.node) {
      var parts = ['#', 'node', enc(route.node)];
      if (route.aspect && route.file) {
        parts.push(enc(route.aspect));
        parts.push(enc(route.file));
      }
      return parts.join('/');
    }
    if (route.aspect) return '#/aspect/' + enc(route.aspect);
    if (route.flow) return '#/flow/' + enc(route.flow);
    return '#/view/' + enc(route.view);
  }

  /**
   * Create a router bound to the live location. `onRoute(route)` fires on every hash change
   * and once at start with the current route. `go(route)` updates the hash (which triggers
   * onRoute via the hashchange listener — one code path, no double render). Returns a small
   * controller; `current()` reads the live route without navigating.
   */
  function create(onRoute) {
    function emit() {
      onRoute(parse(window.location.hash));
    }
    function go(route) {
      var next = serialize(route);
      if (window.location.hash === next) {
        emit(); // same hash — re-emit so a repeat selection still re-renders
      } else {
        window.location.hash = next;
      }
    }
    function current() {
      return parse(window.location.hash);
    }
    function start() {
      window.addEventListener('hashchange', emit);
      emit();
    }
    return { go: go, current: current, start: start };
  }

  Yg.router = {
    VIEWS: VIEWS,
    parse: parse,
    serialize: serialize,
    create: create,
    isKnownView: isKnownView,
  };
})();
