/*
 * Portal bootstrap — orchestrate the foundation into a running page.
 *
 * Wires the shared modules (already on the page, attached to window.YgPortal) into one
 * application: resolve the PortalData (inlined snapshot, present on both the static export
 * and the served first load), build the persistent shell, wire the hash router, the ⌘K
 * palette, the theme toggle, and the view dispatcher. Every navigation flows through the
 * router so a deep link and a click share one code path — reloading a hash reopens exactly
 * what it names, including a node's panel.
 *
 * This is the last script the page loads, so every module it calls is defined. Browser
 * globals only — no framework, no bundler, no network on the static page, no Node.
 */
(function () {
  'use strict';

  var Yg = window.YgPortal || {};
  var dom = Yg.dom;

  /** Persist + apply the theme via the document's data-theme attribute. */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem('yg-portal-theme', theme);
    } catch (_e) {
      /* storage may be unavailable (private mode / file://) — ignore */
    }
  }

  function initialTheme() {
    try {
      var saved = window.localStorage.getItem('yg-portal-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (_e) {
      /* ignore */
    }
    return document.documentElement.getAttribute('data-theme') || 'light';
  }

  function toggleTheme() {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  }

  function fatal(root, message) {
    var box = dom ? dom.el('div', 'portal-error', message) : document.createElement('div');
    if (!dom) box.textContent = message;
    root.appendChild(box);
  }

  function boot() {
    var root = document.getElementById('portal-root');
    if (!root) return;

    if (!dom || !Yg.consumer || !Yg.shell || !Yg.dispatch || !Yg.router) {
      fatal(root, 'Portal modules failed to load.');
      return;
    }

    var data = Yg.consumer.initial();
    if (!data || !data.meta) {
      fatal(root, 'Portal data could not be read.');
      return;
    }

    applyTheme(initialTheme());

    var router = Yg.router.create(onRoute);
    var palette = Yg.palette.create(data, router);

    // The live PortalData the views render — replaced by Refresh / Approve so the file-aware
    // loop visibly updates in place (a touched file flips to unverified; an Approve re-greens).
    var live = data;

    var shell = Yg.shell.build(root, data, {
      onNavigate: function (view) {
        router.go({ view: view });
      },
      onSearch: function () {
        palette.open();
      },
      onRefresh: function () {
        // The server re-extract is read-only (free deterministic re-run); on the static page the
        // button is disabled. A successful refresh swaps in the fresh data and re-renders the
        // current route, so a just-touched file reads unverified everywhere immediately.
        shell.setFreshness('Refreshing · re-running free checks…', 'muted');
        Yg.consumer
          .refresh()
          .then(function (fresh) {
            if (fresh && fresh.meta) {
              live = fresh;
              rerender();
            }
            shell.setFreshness('Refreshed · re-checked free', '');
          })
          .catch(function () {
            shell.setFreshness('Refresh unavailable (static export)', 'muted');
          });
      },
      onApprove: function () {
        runApproveFlow();
      },
      onTheme: toggleTheme,
    });

    /**
     * The Approve flow: fetch the free dry-run cost preview FIRST and show it on the button, then
     * ask for confirmation before the one write. After the write, re-render so any new
     * refusal/unverified surfaces (never a silent success). View-only / static modes never reach
     * here (the button is disabled), but the server also rejects a stray POST with 409.
     */
    function runApproveFlow() {
      if (!live.meta.writeEnabled) {
        shell.setFreshness('View-only mode — the write action is disabled', 'muted');
        return;
      }
      shell.setFreshness('Previewing the Approve cost…', 'muted');
      Yg.consumer
        .approveDryRun(true)
        .then(function (preview) {
          var msg =
            'Approve will run the reviewer for ' +
            preview.pairs +
            ' pending check(s) — ' +
            preview.reviewerCalls +
            ' reviewer call(s) (' +
            preview.deterministic +
            ' script-rule check(s), free). Proceed?';
          var ok = true;
          try {
            if (typeof window.confirm === 'function') ok = window.confirm(msg);
          } catch (_e) {
            ok = true;
          }
          if (!ok) {
            shell.setFreshness('Approve cancelled — nothing was written', 'muted');
            return;
          }
          shell.setFreshness('Approving · running the reviewer…', 'muted');
          return Yg.consumer.approve(true).then(function () {
            return Yg.consumer.refresh().then(function (fresh) {
              if (fresh && fresh.meta) {
                live = fresh;
                rerender();
              }
              shell.setFreshness('Filled · re-checked', '');
            });
          });
        })
        .catch(function (e) {
          var why = e && e.message === 'view-only' ? 'View-only mode — write disabled' : 'Approve unavailable (static export)';
          shell.setFreshness(why, 'muted');
        });
    }

    /** Re-render the current route against the live (possibly refreshed) data. */
    function rerender() {
      onRoute(router.current());
    }

    // The general router hop the views wire their §3a transitions through.
    function navigate(route) {
      router.go(route);
    }

    function onRoute(route) {
      shell.setActive(route.view);
      shell.setBreadcrumb(route);
      Yg.dispatch.render(
        shell.stage,
        route,
        live,
        function (path) {
          router.go({ view: 'tree', node: path });
        },
        navigate,
      );
      // Reload-to-entity: a node hash opens its full attestation panel, co-present with the view.
      renderPanel(shell.panel, route, live, navigate);
    }

    router.start();
  }

  /** Render the node attestation panel (Yg.views.panel) for a deep-linked / selected node. */
  function renderPanel(panel, route, data, navigate) {
    if (Yg.views && typeof Yg.views.panel === 'function') {
      Yg.views.panel(panel, route, data, { navigate: navigate });
      return;
    }
    // Fallback (panel module absent): keep the slot honest rather than blank.
    dom.clear(panel);
    if (!route.node) {
      panel.classList.remove('open');
      return;
    }
    panel.classList.add('open');
    panel.appendChild(dom.el('h3', 'panel-title', route.node));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
