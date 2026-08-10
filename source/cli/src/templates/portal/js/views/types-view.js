/*
 * V6 Type Model — the architecture vocabulary as CAPABILITY DISCOVERY.
 *
 * "What Yggdrasil can enforce here, and how", seen live on your repo (§3.5/§3a V6). Every node
 * TYPE the architecture defines, as a card: its description, whether it classifies files or is
 * organizational, its strict / log flags, its live node-count, what it may nest under (parents),
 * what it may depend on (the allowed-relations matrix row), and the rules it carries by default.
 *
 * This surface renders no verdict state — it is the architecture's grammar, not a pass/fail of
 * any code — so it deliberately paints no green: the relation hues are relation TYPES, never a
 * verdict, and a node-count is a fact, not an approval. The honest-state model still owns every
 * verdict color elsewhere; this view simply never claims one.
 *
 * Transitions (§3a V6): a default-rule chip → V5 (that rule in the rulebook); "nodes of this
 * type" → V3 (the structure tree). Browser globals only; reads the resolved PortalData; no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;
  Yg.views = Yg.views || {};

  // Relation type → a stable, colorblind-safe hue (a relation TYPE marker, never a verdict state).
  var REL_COLOR = {
    calls: '#0d74ce',
    uses: '#208368',
    extends: '#9a6700',
    implements: '#8e4ec6',
    emits: '#d6409f',
    listens: '#d6409f',
  };

  // How many distinct relation types the engine resolves per type (uses / calls / extends /
  // implements / emits / listens — core/allowed-relation-types.ts RELATION_TYPES.length). A
  // browser module has no import of that engine constant, so it is mirrored here as a literal;
  // it is what makes "every one of the six entries is 'any'" a real, checkable condition rather
  // than an assumption about array length.
  var REL_TYPE_COUNT = 6;

  /** True when `allowed` is the full six-entries-all-'any' shape: no restriction declared at all. */
  function isUnrestricted(allowed) {
    return !!allowed && allowed.length === REL_TYPE_COUNT && allowed.every(function (a) {
      return a.targets === 'any';
    });
  }

  /**
   * The "may depend on" line: `allowed` is the engine's ALREADY-RESOLVED allow-list
   * (`PortalTypeAllowed[]`) — an omitted relation type is forbidden, `targets === 'any'` means
   * that relation type may target every component kind. There is no `'deny'`/`'default'` token
   * left to filter; the array itself is the truth.
   */
  function dependsOn(allowed) {
    var wrap = dom.el('div', 'ty-rels');
    // ABSENT data (undefined/null — the field never arrived) is a GAP, checked before the
    // empty-array check below: `[]` is the engine's real, resolved "every relation type
    // forbidden" answer, but a missing `allowed` is not an answer at all. Rendering it as
    // "structural parent only (no code dependency permitted)" would repeat, on a data gap, the
    // exact false "nothing is permitted" claim this task exists to remove — never collapse the
    // two. Unreachable today (the contract field is required and always populated by the
    // pipeline); this is hardening against a future field rename silently falling through here.
    if (!allowed) {
      wrap.appendChild(dom.el('span', 'ty-rel-none', 'allow-list unavailable — data missing, not a restriction'));
      return wrap;
    }
    if (!allowed.length) {
      wrap.appendChild(dom.el('span', 'ty-rel-none', '— structural parent only (no code dependency permitted)'));
      return wrap;
    }
    if (isUnrestricted(allowed)) {
      wrap.appendChild(dom.el('span', 'ty-rel-none', 'no restriction declared — may depend on any component type'));
      return wrap;
    }
    for (var i = 0; i < allowed.length; i += 1) {
      var a = allowed[i];
      var group = dom.el('span', 'ty-relgroup');
      var label = dom.el('b', 'ty-reltype');
      label.style.color = REL_COLOR[a.type] || 'var(--text-secondary)';
      label.textContent = a.type;
      group.appendChild(label);
      var targetsText = a.targets === 'any' ? 'any component type' : a.targets.join(' · ');
      group.appendChild(dom.el('span', 'ty-reltargets', ' ' + targetsText));
      wrap.appendChild(group);
    }
    return wrap;
  }

  /** The default-rules line: each rule a clickable chip routing to its detail in V5. */
  function defaultRules(aspects, nav) {
    if (!aspects || !aspects.length) return dom.el('span', 'ty-rel-none', '—');
    var wrap = dom.el('span', 'ty-asps');
    for (var i = 0; i < aspects.length; i += 1) {
      var chip = dom.el('button', 'ty-asp mono');
      chip.type = 'button';
      chip.textContent = aspects[i];
      chip.addEventListener(
        'click',
        (function (id) {
          return function () {
            nav({ view: 'rulebook', aspect: id });
          };
        })(aspects[i]),
      );
      wrap.appendChild(chip);
    }
    return wrap;
  }

  function typeCard(type, nav) {
    var card = dom.el('div', 'ty-card');

    var head = dom.el('div', 'ty-head');
    head.appendChild(dom.el('b', 'mono ty-name', type.id));
    // The classifying/organizational badge keys off `type.classifying` (the type's own file-
    // classification predicate, `def.when !== undefined`) — NEVER off the resolved `allowed`
    // relations. Deriving it from relations would flip every kind to "classifying" on a
    // permissive project, where every relation type resolves to 'any'.
    head.appendChild(dom.el('span', 'ty-badge ' + (type.classifying ? 'ty-badge-cls' : 'ty-badge-org'), type.classifying ? 'classifying' : 'organizational'));
    if (type.strict) head.appendChild(dom.el('span', 'ty-badge ty-badge-strict', 'strict'));
    if (type.logRequired) head.appendChild(dom.el('span', 'ty-badge ty-badge-log', 'log'));

    var count = dom.el('button', 'ty-count');
    count.type = 'button';
    count.textContent = type.nodeCount + (type.nodeCount === 1 ? ' node' : ' nodes');
    count.addEventListener('click', function () {
      nav({ view: 'tree', type: type.id });
    });
    head.appendChild(count);
    card.appendChild(head);

    if (type.description) card.appendChild(dom.el('div', 'ty-desc', type.description));

    var kv = dom.el('dl', 'ty-kv');
    kv.appendChild(dom.el('dt', null, 'nests under'));
    var parents = dom.el('dd', 'mono', (type.parents && type.parents.length) ? type.parents.join(' · ') : '— (top level)');
    kv.appendChild(parents);

    kv.appendChild(dom.el('dt', null, 'may depend on'));
    var dd = dom.el('dd');
    // No `|| []` — `dependsOn` itself distinguishes ABSENT (a data gap) from an empty array (a
    // real, resolved "forbidden" answer); collapsing the two here would erase that distinction
    // before it ever reaches the branch that cares about it.
    dd.appendChild(dependsOn(type.allowed));
    kv.appendChild(dd);

    kv.appendChild(dom.el('dt', null, 'default rules'));
    var ddR = dom.el('dd');
    ddR.appendChild(defaultRules(type.defaultAspects, nav));
    kv.appendChild(ddR);
    card.appendChild(kv);

    return card;
  }

  function summary(types) {
    var strict = 0;
    var logged = 0;
    for (var i = 0; i < types.length; i += 1) {
      if (types[i].strict) strict += 1;
      if (types[i].logRequired) logged += 1;
    }
    return types.length + ' types · ' + strict + ' strict (every matching file must be captured) · ' + logged + ' log-gated (changes must record a reason)';
  }

  Yg.views.types = function (stage, route, data, ctx) {
    var nav = ctx && ctx.navigate ? ctx.navigate : function () {};
    var types = (data.types || []).slice();

    stage.appendChild(dom.el('p', 'view-lead', 'Every kind of component the architecture defines — what it may depend on, and the rules it carries by default. This is what is possible and how, seen live on your repo. It is the grammar, not a verdict: nothing here is green or red.'));
    stage.appendChild(dom.el('div', 'rb-sub', summary(types)));

    var grid = dom.el('div', 'ty-grid');
    for (var i = 0; i < types.length; i += 1) {
      grid.appendChild(typeCard(types[i], nav));
    }
    stage.appendChild(grid);
  };
})();
