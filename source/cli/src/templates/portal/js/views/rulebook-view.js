/*
 * V5 Rulebook — the aspect catalogue + per-aspect node list with HONEST cells.
 *
 * The rulebook a lead screen-shares (§3.5, §3a V5). Every rule the code must satisfy, as a
 * searchable catalogue: id + rule prose, a kind badge (LLM / deterministic / aggregating), a
 * status badge (draft / advisory / enforced), scope (per node / file + `when` presence), how
 * many nodes it lands on, and a coverage micro-summary. The micro-summary has THREE DISTINCT
 * honest renderings the contract keeps apart and this view must never collapse into one green:
 *   - normal     — a real V/R/U tally over the aspect's expected units (a reviewer/check ran).
 *   - aggregate  — an aggregating bundle has no own reviewer: it "judges nothing".
 *   - vacuous    — a rule-bearing aspect with ZERO expected units "verifies nothing", with the
 *                  resolved reason (draft / no effective node / scope-when excludes all).
 * Selecting an aspect expands the node list it lands on, each node rendered with its honest
 * verdict cell (§3a V5: aspect row → node cell → SHELL-panel). Every state treatment is read
 * from the one shared honest-state model; nothing here invents a green.
 *
 * Browser globals only — reads the already-resolved PortalData; no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;
  Yg.views = Yg.views || {};

  /** A kind badge (LLM / deterministic / aggregating) — presentation only, never a verdict. */
  function kindBadge(kind) {
    var label = kind === 'llm' ? 'reviewer rule' : kind === 'aggregate' ? 'bundle' : 'script rule';
    return dom.el('span', 'rb-badge rb-badge-' + kind, label);
  }

  /** A status badge (draft / advisory / enforced) — rendering of how a verdict blocks, not green. */
  function statusBadge(status) {
    return dom.el('span', 'rb-st rb-st-' + status, status);
  }

  /**
   * The honest coverage cell for one aspect tally. NEVER green for an aspect that judges or
   * verifies nothing: an aggregate reads "judges nothing", a vacuous aspect reads "verifies
   * nothing" with its reason. A normal tally paints a micro-bar sized by the real V/R/U states.
   */
  function tallyCell(tally) {
    var cell = dom.el('td', 'rb-cov');
    if (tally.render === 'aggregate') {
      cell.appendChild(dom.el('span', 'rb-note', 'judges nothing — bundle (state = union of children)'));
      return cell;
    }
    if (tally.render === 'vacuous') {
      var note = dom.el('span', 'rb-note rb-note-vacuous', 'verifies nothing — ' + tally.reason);
      cell.appendChild(note);
      return cell;
    }
    // normal — a micro-bar sized by the real pair states, so an unverified unit never paints
    // green and an advisory refusal paints its own warning segment, never a blocking red.
    var bar = dom.el('div', 'rb-bar');
    var warning = tally.warning || 0;
    var segs = [
      { state: 'verified', n: tally.verified },
      { state: 'refused', n: tally.refused },
      { state: 'warning', n: warning },
      { state: 'unverified', n: tally.unverified },
    ];
    for (var i = 0; i < segs.length; i += 1) {
      if (segs[i].n <= 0) continue;
      var seg = dom.el('i', 'rb-bar-seg ' + Yg.states.cssClass(segs[i].state));
      seg.style.flex = String(segs[i].n);
      bar.appendChild(seg);
    }
    if (!bar.firstChild) bar.appendChild(dom.el('i', 'rb-bar-seg ' + Yg.states.cssClass('no-rule')));
    cell.appendChild(bar);
    var num =
      tally.verified + ' verified / ' + tally.refused + ' refused / ' +
      (warning > 0 ? warning + ' advisory / ' : '') + tally.unverified + ' unverified';
    cell.appendChild(dom.el('div', 'rb-covnum mono', num));
    return cell;
  }

  /** One aspect row in the catalogue table. Clicking the id toggles its per-node expansion. */
  function aspectRow(a, selected, nav) {
    var tr = dom.el('tr', 'rb-row' + (selected ? ' rb-row-sel' : ''));

    var idCell = dom.el('td', 'rb-aid');
    var idBtn = dom.el('button', 'rb-idbtn mono');
    idBtn.type = 'button';
    idBtn.textContent = a.id;
    idBtn.addEventListener('click', function () {
      // Toggle: clicking the open aspect collapses it (route back to the bare rulebook).
      nav(selected ? { view: 'rulebook' } : { view: 'rulebook', aspect: a.id });
    });
    idCell.appendChild(idBtn);
    var prose = a.description || (a.ruleProse ? firstLine(a.ruleProse) : '') || a.name;
    if (prose) idCell.appendChild(dom.el('span', 'rb-desc', prose));
    tr.appendChild(idCell);

    tr.appendChild(dom.el('td', null, kindBadge(a.kind)));
    tr.appendChild(dom.el('td', null, statusBadge(a.status)));

    var scopeCell = dom.el('td', 'mono rb-scope');
    scopeCell.textContent = a.kind === 'aggregate' ? '—' : 'per:' + a.scope + (a.hasWhen ? ' · when' : '');
    tr.appendChild(scopeCell);

    var appliesCell = dom.el('td', 'rb-applies');
    appliesCell.textContent = appliesText(a);
    tr.appendChild(appliesCell);

    tr.appendChild(tallyCell(a.tally));
    return tr;
  }

  /** "Applies to N nodes" / "via implies" / "0 nodes" — derived honestly from the tally. */
  function appliesText(a) {
    if (a.kind === 'aggregate') return 'via implies';
    if (a.tally.render === 'vacuous') return '0 nodes';
    return a.tally.units + (a.tally.units === 1 ? ' unit' : ' units');
  }

  /** The first non-heading prose line of a content.md, for a one-line description. */
  function firstLine(prose) {
    var lines = String(prose).split('\n');
    for (var i = 0; i < lines.length; i += 1) {
      var t = lines[i].trim();
      if (t && t.charAt(0) !== '#') return t.length > 140 ? t.slice(0, 137) + '…' : t;
    }
    return '';
  }


  function counts(aspects) {
    var llm = 0;
    var det = 0;
    var agg = 0;
    for (var i = 0; i < aspects.length; i += 1) {
      if (aspects[i].kind === 'llm') llm += 1;
      else if (aspects[i].kind === 'aggregate') agg += 1;
      else det += 1;
    }
    return aspects.length + ' rules · ' + llm + ' reviewer · ' + det + ' script · ' + agg + ' bundle';
  }

  Yg.views.rulebook = function (stage, route, data, ctx) {
    var nav = ctx && ctx.navigate ? ctx.navigate : function () {};
    var aspects = (data.aspects || []).slice();
    var selectedId = route && route.aspect ? route.aspect : null;

    stage.appendChild(dom.el('p', 'view-lead', 'Every rule the code must satisfy — the rulebook. A green tally means a reviewer actually checked those units; a bundle judges nothing of its own, and a rule with no expected units verifies nothing. Absence of red is not a pass. Click a rule to see every node it lands on.'));
    stage.appendChild(dom.el('div', 'rb-sub', counts(aspects)));

    var table = dom.el('table', 'rb-table');
    var thead = dom.el('thead');
    var htr = dom.el('tr');
    ['rule', 'kind', 'status', 'scope', 'applies', 'coverage'].forEach(function (h) {
      htr.appendChild(dom.el('td', null, h));
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = dom.el('tbody');
    var selectedAspect = null;
    for (var i = 0; i < aspects.length; i += 1) {
      var isSel = aspects[i].id === selectedId;
      if (isSel) selectedAspect = aspects[i];
      tbody.appendChild(aspectRow(aspects[i], isSel, nav));
      // The selected rule's full detail opens in the shared inspector panel (the aspect-side
      // mirror of the node attestation), reached via the #/aspect/<id> route — not inline here.
    }
    table.appendChild(tbody);
    stage.appendChild(table);

    if (!selectedAspect && selectedId) {
      // A deep-linked aspect id that no longer exists — honest, never a blank.
      stage.appendChild(dom.el('p', 'rb-empty', 'No rule named "' + selectedId + '" — it may have been removed.'));
    }
  };
})();
