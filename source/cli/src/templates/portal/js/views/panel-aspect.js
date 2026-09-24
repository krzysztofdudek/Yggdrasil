/*
 * Aspect inspector — the aspect-side mirror of the node attestation panel.
 *
 * Renders ONE rule into the shared right-hand panel: Yg.views.panel delegates here for an aspect
 * route. Shows the rule's identity (kind / status / scope / when), the actual rule prose
 * (content.md) for a reviewer rule or an honest note for a deterministic / aggregate one, its implies
 * chain, and every component it lands on with that component's honest verdict (each cell routing
 * to the component's own panel). Split out of panel-view.js so each file stays a focused unit.
 *
 * Browser globals only — reads the already-resolved PortalData; no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;

  /** A titled panel section with an optional count label (mirrors panel-view's own helper). */
  function section(title, countLabel) {
    var s = dom.el('section', 'pan-sect');
    var h = dom.el('h5', 'pan-h', title);
    if (countLabel != null) h.appendChild(dom.el('span', 'pan-count', ' · ' + countLabel));
    s.appendChild(h);
    return s;
  }

  /**
   * One honest per-node cell for an aspect: the node's verdict state for THIS rule + the path,
   * routing to that node's own attestation panel. Reuses the rulebook cell classes.
   */
  function aspectNodeCell(node, eff, na, nav) {
    var state = na ? 'not-applicable' : !eff ? 'no-rule' : eff.pairState === 'n/a' ? 'not-applicable' : eff.pairState;
    var cell = dom.el('button', 'rb-cell ' + Yg.states.cssClass(state));
    cell.type = 'button';
    cell.appendChild(Yg.states.badge(state));
    cell.appendChild(dom.el('span', 'mono', node.path));
    cell.appendChild(dom.el('span', 'rb-cell-st', Yg.states.label(state)));
    cell.addEventListener('click', function () {
      nav({ view: 'tree', node: node.path });
    });
    return cell;
  }

  /**
   * Render a RULE into the shared panel — its identity (kind / status / scope / when), the actual
   * rule prose (content.md) for a reviewer rule or an honest note for a deterministic / aggregate one,
   * its implies chain, and every node it lands on with that node's honest verdict.
   */
  function renderAspectPanel(panel, route, data, nav) {
    var close = dom.el('button', 'pan-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close panel');
    close.addEventListener('click', function () {
      nav({ view: route.view || 'rulebook' });
    });
    panel.appendChild(close);

    var aspect = (data.aspects || []).filter(function (a) {
      return a.id === route.aspect;
    })[0];
    if (!aspect) {
      panel.appendChild(dom.el('h3', 'panel-title mono', route.aspect));
      panel.appendChild(dom.el('p', 'panel-sub', 'No rule named "' + route.aspect + '" — it may have been removed.'));
      return;
    }

    // Identity.
    var head = dom.el('div', 'pan-head pan-aspect');
    head.appendChild(dom.el('div', 'pan-title mono', aspect.id));
    var meta = dom.el('div', 'pan-meta');
    meta.appendChild(
      dom.el('span', 'rb-badge rb-badge-' + aspect.kind, aspect.kind === 'llm' ? 'reviewer rule' : aspect.kind === 'aggregate' ? 'bundle' : 'script rule'),
    );
    meta.appendChild(dom.el('span', 'rb-st rb-st-' + aspect.status, aspect.status));
    if (aspect.kind !== 'aggregate') meta.appendChild(dom.el('span', 'mono', 'per:' + aspect.scope + (aspect.hasWhen ? ' · when' : '')));
    head.appendChild(meta);
    if (aspect.name && aspect.name !== aspect.id) head.appendChild(dom.el('p', 'pan-desc', aspect.name));
    panel.appendChild(head);

    // The rule itself — the exact text the reviewer enforces: the LLM prose (content.md), or the
    // deterministic check's own source (check.mjs) for a local check, or an honest note for a bundle.
    var ruleSect = section('The rule');
    if (aspect.ruleProse) {
      ruleSect.appendChild(dom.el('pre', 'pan-rule', aspect.ruleProse));
    } else if (aspect.checkSource) {
      ruleSect.appendChild(dom.el('div', 'pan-rule-h', 'A deterministic local check — the exact source that enforces it:'));
      ruleSect.appendChild(dom.el('pre', 'pan-rule pan-rule-code', aspect.checkSource));
    } else if (aspect.kind === 'aggregate') {
      ruleSect.appendChild(dom.el('p', 'pan-norule', 'A bundle — it groups the rules below and judges nothing of its own.'));
    } else {
      ruleSect.appendChild(dom.el('p', 'pan-norule', 'A deterministic local check enforces this rule mechanically. Its state is the union of the cells below.'));
    }
    panel.appendChild(ruleSect);

    // Implies chain (clickable to each included rule).
    if (aspect.implies && aspect.implies.length) {
      var impSect = section('Includes', String(aspect.implies.length));
      var ul = dom.el('ul', 'pan-rels');
      for (var k = 0; k < aspect.implies.length; k += 1) {
        var li = dom.el('li', 'pan-rel');
        var link = dom.el('button', 'pan-rellink mono');
        link.type = 'button';
        link.textContent = aspect.implies[k];
        link.addEventListener('click', (function (id) {
          return function () {
            nav({ view: 'rulebook', aspect: id });
          };
        })(aspect.implies[k]));
        li.appendChild(link);
        ul.appendChild(li);
      }
      impSect.appendChild(ul);
      panel.appendChild(impSect);
    }

    // Every node it lands on, each with its honest verdict for THIS rule.
    var cellSect = section('Every component it lands on');
    var cells = dom.el('div', 'rb-cells');
    var found = 0;
    var nodes = data.nodes || [];
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var eff = (node.effectiveAspects || []).filter(function (e) {
        return e.aspectId === aspect.id;
      })[0];
      var na = !eff
        ? (node.notApplicable || []).filter(function (e) {
            return e.aspectId === aspect.id;
          })[0]
        : null;
      if (!eff && !na) continue;
      found += 1;
      cells.appendChild(aspectNodeCell(node, eff, na, nav));
    }
    if (!found) cells.appendChild(dom.el('p', 'rb-empty', 'This rule lands on no component right now — it verifies nothing. Not a pass.'));
    cellSect.appendChild(cells);
    panel.appendChild(cellSect);
  }

  Yg.panelAspect = renderAspectPanel;
})();
