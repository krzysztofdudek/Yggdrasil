/*
 * Shell — the persistent three-region chrome rendered on every view.
 *
 * Builds and owns the frame the whole portal lives in:
 *   - LEFT nav rail: brand (-> overview), a ⌘K trigger, and the grouped view links
 *     ("Get oriented" / "Inspect & audit"), the active one highlighted.
 *   - TOP bar: a live-status pill + Refresh + Approve control cluster, a breadcrumb, the
 *     ⌘K search trigger, a write/view-only indicator, and the theme toggle.
 *   - RIGHT panel slot: an empty mount the Node Attestation panel slides into on selection.
 *   - CENTER stage: the mount the view dispatcher renders the current view into.
 *
 * The shell is built ONCE; navigation only swaps the center stage and updates the rail
 * highlight + breadcrumb, so the chrome is stable. Browser globals only — Refresh/Approve
 * are wired by the boot to the server (or disabled on a static page); no network here.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;

  // Nav rail groups -> view ids, mirroring §3a primary navigation.
  var NAV_GROUPS = [
    {
      title: 'Get oriented',
      items: [
        { view: 'overview', glyph: '◧', label: 'Overview' },
        { view: 'start', glyph: '◆', label: 'Start here' },
        { view: 'flows', glyph: '⤳', label: 'Flows' },
        { view: 'rulebook', glyph: '▤', label: 'Rulebook' },
        { view: 'types', glyph: '◇', label: 'Type model' },
      ],
    },
    {
      title: 'Inspect & audit',
      items: [
        { view: 'coverage', glyph: '▦', label: 'Coverage & audit' },
        { view: 'tree', glyph: '⌗', label: 'Structure' },
        { view: 'relations', glyph: '↔', label: 'Relations & boundaries' },
        { view: 'structure', glyph: '⋔', label: 'Dependency structure' },
        { view: 'suppressions', glyph: '⛉', label: 'Suppressions' },
      ],
    },
  ];

  /**
   * Build the shell into `root` for a given PortalData. `handlers` carries the user actions
   * the chrome triggers: { onNavigate(view), onSearch(), onRefresh(), onApprove(), onTheme() }.
   * Returns a controller exposing the live region mounts and the per-navigation updaters.
   */
  function build(root, data, handlers) {
    dom.clear(root);
    var app = dom.el('div', 'app-grid');

    var rail = buildRail(data, handlers);
    var main = dom.el('main', 'app-main');
    var topbar = buildTopbar(data, handlers);
    var stage = dom.el('div', 'app-stage');
    main.appendChild(topbar.el);
    main.appendChild(stage);

    var panel = dom.el('aside', 'app-panel');
    panel.setAttribute('aria-label', 'Node attestation panel');

    app.appendChild(rail.el);
    app.appendChild(main);
    app.appendChild(panel);

    // The honest key as ONE pinned, collapsible bottom bar — built once here, never inside a
    // view's scrolling stage, so it can be pinned and the stage clears it via its bottom padding.
    if (Yg.dispatch && typeof Yg.dispatch.buildLegendBar === 'function') {
      app.appendChild(Yg.dispatch.buildLegendBar());
    }

    root.appendChild(app);

    return {
      stage: stage,
      panel: panel,
      setActive: function (view) {
        rail.setActive(view);
      },
      setBreadcrumb: function (route) {
        topbar.setBreadcrumb(route);
      },
      setFreshness: function (text, tone) {
        topbar.setFreshness(text, tone);
      },
    };
  }

  function buildRail(data, handlers) {
    var rail = dom.el('aside', 'app-rail');
    rail.setAttribute('aria-label', 'Primary navigation');

    var brand = dom.el('button', 'rail-brand');
    brand.type = 'button';
    // The brand mark: reuse the inline data: URI the serializer injected into the favicon
    // link (single source, no network). Guarded so the non-DOM test sandbox (no querySelector)
    // and any environment lacking the link simply omit the mark rather than break. The mark is
    // decorative (alt=''), as the adjacent text already names the product.
    var favicon = document.querySelector && document.querySelector('link[rel~="icon"]');
    if (favicon && favicon.getAttribute('href')) {
      var logo = dom.el('img', 'rail-logo');
      logo.src = favicon.getAttribute('href');
      logo.alt = '';
      brand.appendChild(logo);
    }
    brand.appendChild(dom.el('b', null, 'Yggdrasil'));
    // A static export is a frozen snapshot (no server), not a live view — say so honestly.
    var brandSub = !Yg.consumer.isServed() ? 'snapshot' : data.meta.writeEnabled ? 'live view' : 'view-only';
    brand.appendChild(dom.el('span', 'rail-brand-sub', brandSub));
    brand.addEventListener('click', function () {
      handlers.onNavigate('overview');
    });
    rail.appendChild(brand);

    var cmdk = dom.el('button', 'rail-cmdk');
    cmdk.type = 'button';
    cmdk.appendChild(dom.el('span', null, '⌕ Search…'));
    cmdk.appendChild(dom.el('kbd', null, '⌘K'));
    cmdk.addEventListener('click', function () {
      handlers.onSearch();
    });
    rail.appendChild(cmdk);

    var links = {};
    for (var g = 0; g < NAV_GROUPS.length; g += 1) {
      var grp = NAV_GROUPS[g];
      rail.appendChild(dom.el('div', 'rail-h', grp.title));
      var nav = dom.el('nav', 'rail-nav');
      for (var i = 0; i < grp.items.length; i += 1) {
        nav.appendChild(buildLink(grp.items[i], handlers, links));
      }
      rail.appendChild(nav);
    }

    return {
      el: rail,
      setActive: function (view) {
        for (var key in links) {
          if (!Object.prototype.hasOwnProperty.call(links, key)) continue;
          if (key === view) links[key].classList.add('on');
          else links[key].classList.remove('on');
        }
      },
    };
  }

  function buildLink(item, handlers, links) {
    var a = dom.el('button', 'rail-link');
    a.type = 'button';
    a.appendChild(dom.el('span', 'rail-glyph', item.glyph));
    a.appendChild(dom.el('span', null, item.label));
    a.addEventListener('click', function () {
      handlers.onNavigate(item.view);
    });
    links[item.view] = a;
    return a;
  }

  function buildTopbar(data, handlers) {
    var bar = dom.el('div', 'app-topbar');

    var live = dom.el('span', 'topbar-live');
    var dot = dom.el('span', 'topbar-dot');
    live.appendChild(dot);
    var liveText = dom.el(
      'span',
      null,
      !Yg.consumer.isServed()
        ? 'Exported snapshot — re-run yg portal for a live view'
        : data.meta.writeEnabled
          ? 'Live · re-checks free on refresh'
          : 'View-only',
    );
    live.appendChild(liveText);
    bar.appendChild(live);

    var crumb = dom.el('span', 'topbar-crumb', '');
    bar.appendChild(crumb);

    var spacer = dom.el('span', 'topbar-spacer');
    bar.appendChild(spacer);

    // Refresh and Approve are live ONLY when the page is served by `yg portal`. On a static
    // export they cannot reach the server, so they are disabled UP FRONT with a plain reason
    // (never click-to-discover), and the page never presents a write it cannot perform.
    var served = Yg.consumer.isServed();
    var staticReason = 'Available only when the portal is served by `yg portal` — this is a read-only export.';

    var refresh = dom.el('button', 'btn topbar-refresh');
    refresh.type = 'button';
    refresh.appendChild(dom.el('span', null, '↻ Refresh'));
    refresh.appendChild(dom.el('span', 'btn-free', 'free'));
    refresh.addEventListener('click', function () {
      handlers.onRefresh();
    });
    if (!served) {
      refresh.disabled = true;
      refresh.title = staticReason;
      refresh.setAttribute('aria-label', 'Refresh — ' + staticReason);
    }
    bar.appendChild(refresh);

    var approve = dom.el('button', 'btn primary topbar-approve', '✓ Approve');
    approve.type = 'button';
    approve.disabled = !data.meta.writeEnabled || !served;
    if (approve.disabled) {
      var approveReason = !served ? staticReason : 'View-only mode (--no-write) — approving is disabled.';
      approve.title = approveReason;
      approve.setAttribute('aria-label', '✓ Approve — ' + approveReason);
    }
    approve.addEventListener('click', function () {
      handlers.onApprove();
    });
    bar.appendChild(approve);

    var search = dom.el('button', 'btn topbar-search', '⌕');
    search.type = 'button';
    search.setAttribute('aria-label', 'Open command palette');
    search.addEventListener('click', function () {
      handlers.onSearch();
    });
    bar.appendChild(search);

    var theme = dom.el('button', 'btn topbar-theme', '◐');
    theme.type = 'button';
    theme.setAttribute('aria-label', 'Toggle light / dark theme');
    theme.addEventListener('click', function () {
      handlers.onTheme();
    });
    bar.appendChild(theme);

    return {
      el: bar,
      setBreadcrumb: function (route) {
        crumb.textContent = breadcrumbText(route);
      },
      setFreshness: function (text, tone) {
        liveText.textContent = text;
        dot.className = 'topbar-dot' + (tone ? ' ' + tone : '');
      },
    };
  }

  function breadcrumbText(route) {
    if (!route) return '';
    if (route.node) return 'Structure / ' + route.node;
    if (route.aspect) return 'Rulebook / ' + route.aspect;
    if (route.flow) return 'Flows / ' + route.flow;
    return labelForView(route.view);
  }

  function labelForView(view) {
    for (var g = 0; g < NAV_GROUPS.length; g += 1) {
      for (var i = 0; i < NAV_GROUPS[g].items.length; i += 1) {
        if (NAV_GROUPS[g].items[i].view === view) return NAV_GROUPS[g].items[i].label;
      }
    }
    return view || '';
  }

  Yg.shell = { build: build, NAV_GROUPS: NAV_GROUPS, _labelForView: labelForView };
})();
