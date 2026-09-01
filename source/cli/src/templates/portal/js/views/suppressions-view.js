/*
 * V8 Suppressions — the risk-first waiver inventory.
 *
 * Suppressed is NOT verified (§3.6, §3a V8): the permanent, surfaced ledger of every deliberate
 * hole and which are dangerous. Every active waiver marker on mapped source as a table —
 * file:line, the waived aspect, the reason text, and a RISK flag resolved by the CLI's own
 * suppress-range resolver (not ad-hoc regex): wildcard (`*`, all aspects off), typo (the
 * aspect-id matches no known aspect), inert (the aspect is draft, so the waiver is a no-op),
 * errs-under (the aspect can never itself false-alarm, so the waiver silences nothing that
 * could actually fire), or unbounded (runs to end of file / a long range). A clean marker (no
 * risk) instead reads its real span — a single line, a range, or the whole file; a whole-file
 * waiver is never called "bounded". Sorted risk-first; a standing banner if any marker is
 * wildcard or unbounded. A waiver NEVER hides the real verdict.
 *
 * The waived state is read from the one shared honest-state model (the `suppressed` treatment),
 * so a waiver can never read as a green pass.
 *
 * Transitions (§3a V8): a marker's location → its node's attestation panel (SHELL-panel); the
 * waived aspect → V5 (the rulebook). Browser globals only; reads the resolved PortalData; no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;
  Yg.views = Yg.views || {};

  // Risk → precedence rank, sorted first-to-last: wildcard > typo > inert > errs-under >
  // unbounded — the SAME order the backend's own resolver picks a risk in when a marker could
  // read more than one way (source/cli/src/portal/api/suppress-adapt.ts, `resolveRisk`). Plain
  // integers, explicit and readable — never a fractional rank shoehorned between two others.
  var RISK_RANK = { wildcard: 0, typo: 1, inert: 2, 'errs-under': 3, unbounded: 4 };
  var RISK_LABEL = {
    wildcard: 'WILDCARD — all aspects off',
    typo: 'TYPO — aspect-id matches no known rule',
    inert: 'INERT — aspect is draft, waiver is a no-op',
    'errs-under': 'WAIVES A RULE THAT CANNOT FALSE-ALARM',
    unbounded: 'RANGE — runs unbounded',
  };

  // Clean-waiver (no risk) label, by the marker's real span (`form`) — never the blanket
  // "bounded" claim: a whole-file waiver is not bounded, so it reads as its own, honest label.
  var FORM_LABEL = {
    line: 'single line · bounded',
    range: 'range · bounded',
    file: 'whole file',
  };

  function riskRank(s) {
    return s.risk && Object.prototype.hasOwnProperty.call(RISK_RANK, s.risk) ? RISK_RANK[s.risk] : 9;
  }

  /** A keyboard-operable export trigger (a native <button>, focusable + Enter/Space-activatable). */
  function exportBtn(label, aria, onClick) {
    var b = dom.el('button', 'exp-btn', label);
    b.type = 'button';
    b.setAttribute('aria-label', aria);
    b.addEventListener('click', onClick);
    return b;
  }

  /** Map the node owning a source file path, for the location → SHELL-panel transition. */
  function nodeForFile(data, file) {
    var nodes = data.nodes || [];
    var best = null;
    for (var i = 0; i < nodes.length; i += 1) {
      var globs = nodes[i].mapping || [];
      for (var g = 0; g < globs.length; g += 1) {
        // A cheap, dependency-free containment: the node's mapping prefix (before any glob char)
        // is a path prefix of the file. The exact owner is authoritative in the panel itself.
        var prefix = String(globs[g]).split(/[*?[]/)[0];
        if (prefix && file.indexOf(prefix) === 0) {
          if (!best || prefix.length > best.prefix) best = { path: nodes[i].path, prefix: prefix.length };
        }
      }
    }
    return best ? best.path : null;
  }

  function riskCell(sup) {
    if (!sup.risk) {
      // Clean waiver: describe its real span, never a blanket "bounded" claim.
      var ok = dom.el('span', 'sup-flag sup-flag-ok', FORM_LABEL[sup.form] || sup.form);
      return ok;
    }
    // A risk present wins the cell outright — the form label is never shown beside it (a row
    // must never read "whole file" and "runs unbounded" at once).
    var cls = sup.risk === 'wildcard' ? 'sup-flag-wild' : sup.risk === 'unbounded' ? 'sup-flag-unb' : 'sup-flag-other';
    return dom.el('span', 'sup-flag ' + cls, RISK_LABEL[sup.risk] || sup.risk);
  }

  function markerRow(sup, data, nav) {
    var tr = dom.el('tr', 'sup-row');

    // Location — the waived state badge + file:line, routing to the owning node's panel.
    var locCell = dom.el('td', 'sup-loc');
    var locBtn = dom.el('button', 'sup-locbtn');
    locBtn.type = 'button';
    locBtn.appendChild(Yg.states.badge('suppressed'));
    locBtn.appendChild(dom.el('span', 'mono sup-locpath', sup.file + ':' + sup.line));
    var owner = nodeForFile(data, sup.file);
    locBtn.addEventListener('click', function () {
      if (owner) nav({ view: 'tree', node: owner });
    });
    if (!owner) locBtn.disabled = true;
    locCell.appendChild(locBtn);
    tr.appendChild(locCell);

    // The waived aspect — routes to its detail in the rulebook.
    var aspCell = dom.el('td');
    var aspBtn = dom.el('button', 'sup-asp mono');
    aspBtn.type = 'button';
    aspBtn.textContent = sup.aspectId;
    aspBtn.addEventListener('click', function () {
      nav({ view: 'rulebook', aspect: sup.aspectId });
    });
    aspCell.appendChild(aspBtn);
    tr.appendChild(aspCell);

    tr.appendChild(dom.el('td', null, riskCell(sup)));

    var reasonCell = dom.el('td', 'sup-reason');
    reasonCell.textContent = '"' + (sup.reason || '') + '" — a waiver, not a pass.';
    tr.appendChild(reasonCell);

    return tr;
  }

  function banner(suppressions) {
    var dangerous = suppressions.filter(function (s) {
      return s.risk === 'wildcard' || s.risk === 'unbounded';
    });
    if (!dangerous.length) return null;
    var wild = dangerous.filter(function (s) {
      return s.risk === 'wildcard';
    }).length;
    var unb = dangerous.length - wild;
    var errsUnder = suppressions.filter(function (s) {
      return s.risk === 'errs-under';
    }).length;
    var msg = '';
    if (wild) msg += wild + ' wildcard marker' + (wild === 1 ? '' : 's') + ' (waives every rule on that line) ';
    if (unb) msg += (msg ? '· ' : '') + unb + ' unbounded range' + (unb === 1 ? '' : 's') + ' ';
    if (errsUnder) msg += (msg ? '· ' : '') + errsUnder + ' waiver' + (errsUnder === 1 ? '' : 's') + ' on a rule that cannot false-alarm ';
    var box = dom.el('div', 'sup-banner');
    box.appendChild(Yg.states.badge('suppressed'));
    box.appendChild(dom.el('span', null, msg + '— review whether each is intended.'));
    return box;
  }

  function summary(suppressions, markerCount) {
    var files = {};
    for (var i = 0; i < suppressions.length; i += 1) files[suppressions[i].file] = true;
    var fileCount = Object.keys(files).length;
    var text = suppressions.length + ' active waiver' + (suppressions.length === 1 ? '' : 's') + ' across ' + fileCount + ' file' + (fileCount === 1 ? '' : 's') + ' — a suppressed line is NOT verified; the reviewer was told to skip it. Sorted risk-first.';
    // Only mention the marker total when it actually differs from the waiver count — a
    // range-closing marker on disk is not itself a waiver, but a sentence that always repeats
    // an equal number invites the reader to hunt for a discrepancy that does not exist.
    if (typeof markerCount === 'number' && markerCount > suppressions.length) {
      text += ' · ' + markerCount + ' markers on disk (a closing marker is not a waiver)';
    }
    return text;
  }

  Yg.views.suppressions = function (stage, route, data, ctx) {
    var nav = ctx && ctx.navigate ? ctx.navigate : function () {};
    var suppressions = (data.suppressions || []).slice().sort(function (a, b) {
      var r = riskRank(a) - riskRank(b);
      if (r !== 0) return r;
      return (a.file + ':' + a.line).localeCompare(b.file + ':' + b.line, 'en');
    });

    stage.appendChild(dom.el('p', 'view-lead', 'Every deliberate waiver, risk-first. A waived line is not verified — someone told the reviewer to skip a rule there, on purpose, with a reason. A waiver never hides the real verdict; it is a documented hole, not a pass.'));

    // Export the inventory as a portable audit artifact (CSV / JSON) — built in-page, no network.
    if (Yg.exporter) {
      var bar = dom.el('div', 'exp-bar');
      bar.appendChild(exportBtn('Export CSV', 'Download the suppression inventory as CSV', function () {
        Yg.exporter.exportSuppressionsCsv(data);
      }));
      bar.appendChild(exportBtn('Export JSON', 'Download the full audit bundle (suppressions, residue, coverage) as JSON', function () {
        Yg.exporter.exportJson(data);
      }));
      stage.appendChild(bar);
    }

    if (!suppressions.length) {
      var empty = dom.el('div', 'sup-empty');
      empty.appendChild(Yg.states.badge('suppressed'));
      empty.appendChild(dom.el('b', null, 'No active waivers.'));
      empty.appendChild(dom.el('p', null, 'Nothing is being skipped on current inputs. That is the honest empty state — not a green, just an empty ledger.'));
      stage.appendChild(empty);
      return;
    }

    var markerCount = data.meta && data.meta.counts ? data.meta.counts.suppressionMarkers : undefined;
    stage.appendChild(dom.el('div', 'rb-sub', summary(suppressions, markerCount)));
    var b = banner(suppressions);
    if (b) stage.appendChild(b);

    var table = dom.el('table', 'sup-table');
    var thead = dom.el('thead');
    var htr = dom.el('tr');
    ['location', 'waived rule', 'risk', 'reason'].forEach(function (h) {
      htr.appendChild(dom.el('td', null, h));
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = dom.el('tbody');
    for (var i = 0; i < suppressions.length; i += 1) {
      tbody.appendChild(markerRow(suppressions[i], data, nav));
    }
    table.appendChild(tbody);
    stage.appendChild(table);
  };
})();
