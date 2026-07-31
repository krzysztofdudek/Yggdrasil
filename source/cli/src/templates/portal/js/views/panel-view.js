/*
 * SHELL-panel — the Node Attestation panel.
 *
 * Turns an opaque checkmark into a citable attestation (§3.2, §3a SHELL-panel). Co-present
 * with any view on node selection, it shows: identity (type + description + mapped globs +
 * mapping-entry count + the real source-file count those entries resolve to); the
 * effective-aspects table (per row: aspect, reviewer kind +
 * tier/consensus, cost, status, the channel-provenance, the honest verdict state, and the
 * folded input set behind a VERIFIED green / the reason behind a REFUSED); relations BOTH
 * directions; the when-filtered-OUT (not-applicable) set as its own list; the per-node log
 * WHY timeline; active suppressions with risk flags; and a copy-attestation-digest action.
 * A no-rule node links to the Type Model so "nothing here" is never a terminal shrug. Every
 * state treatment is read from the one shared honest-state model.
 *
 * Browser globals only — reads the already-resolved PortalData; no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;
  Yg.views = Yg.views || {};

  var CHANNELS = ['', 'own', 'ancestor', 'own-type', 'ancestor-type', 'flow', 'port', 'implied'];

  function section(title, countLabel) {
    var s = dom.el('section', 'pan-sect');
    var h = dom.el('h5', 'pan-h', title);
    if (countLabel != null) h.appendChild(dom.el('span', 'pan-count', ' · ' + countLabel));
    s.appendChild(h);
    return s;
  }

  /** A plain-language sentence for an aspect's reviewer kind / tier / consensus / cost. */
  function kindPlain(a) {
    if (a.kind === 'llm') {
      var s = 'An AI reviewer';
      if (a.tier) s += ' on the “' + a.tier + '” tier';
      if (a.consensus) s += ', voting ' + a.consensus + '×,';
      s += ' judges this rule';
      s += a.cost === 'billed' ? ' — it may cost a paid API call.' : ' — free (a local reviewer).';
      return s;
    }
    if (a.kind === 'aggregate') return 'A bundle that groups other rules — it judges nothing of its own.';
    return 'A free local script checks this rule mechanically — no AI, no cost.';
  }

  function aspectRow(a, nav) {
    var row = dom.el('div', 'pan-asprow');
    var name = dom.el('button', 'pan-aspname mono');
    name.type = 'button';
    name.textContent = a.aspectId;
    var aspectDef = Yg.glossary && Yg.glossary.lookup ? Yg.glossary.lookup('aspect') : null;
    if (aspectDef) name.setAttribute('title', a.aspectId + ' — ' + aspectDef);
    name.addEventListener('click', function () {
      nav({ view: 'rulebook', aspect: a.aspectId });
    });
    row.appendChild(name);

    var kindLabel =
      a.kind === 'llm'
        ? 'LLM' + (a.tier ? ' · ' + a.tier + ' tier' : '') + (a.consensus ? ' · ' + a.consensus + ' opinion' : '') + ' · ' + (a.cost === 'billed' ? 'billed' : 'free')
        : a.kind === 'aggregate'
          ? 'aggregating · judges nothing'
          : 'deterministic · free';
    // Plain-language tooltip so the dense kind / tier / cost vocabulary is legible to a non-expert.
    var badge = dom.el('span', 'pan-badge pan-badge-' + a.kind, kindLabel);
    badge.setAttribute('title', kindPlain(a));
    badge.setAttribute('aria-label', kindLabel + ' — ' + kindPlain(a));
    row.appendChild(badge);
    // The provenance / attach channel, with a plain definition (own / ancestor / type / flow / …).
    var chanId = CHANNELS[a.channel] || a.origin || '';
    var chan = dom.el('span', 'pan-chan', chanId);
    var chanDef = chanId && Yg.glossary && Yg.glossary.lookup ? Yg.glossary.lookup(chanId) : null;
    if (chanDef) {
      chan.setAttribute('title', chanDef);
      chan.setAttribute('aria-label', chanId + ': ' + chanDef);
      chan.setAttribute('tabindex', '0');
    }
    row.appendChild(chan);
    var st = a.pairState === 'n/a' ? 'not-applicable' : a.pairState;
    row.appendChild(Yg.states.badge(st));

    // Drill-through: folded inputs (verified) or the reason (refused).
    if (a.pairState === 'verified' && a.foldedInputs && a.foldedInputs.length) {
      var drill = dom.el('div', 'pan-drill');
      drill.appendChild(dom.el('div', 'pan-drill-h', 'This green attests these exact bytes:'));
      for (var i = 0; i < a.foldedInputs.length; i += 1) {
        var c = dom.el('div', 'pan-check');
        c.appendChild(dom.el('span', 'pan-check-c', '✓'));
        c.appendChild(dom.el('span', 'mono', a.foldedInputs[i]));
        drill.appendChild(c);
      }
      // The tier/secrets-overlay caveat is about the LLM reviewer's tier ONLY.
      // A deterministic check has no tier/reviewer, so the note is irrelevant
      // (and misleading) there — gate it to LLM aspects.
      if (a.kind === 'llm') {
        drill.appendChild(dom.el('div', 'pan-caveat', 'Tier config may be locally overridden via a secrets overlay; only the tier name is hashed. Shown values come from committed config only.'));
      }
      row.appendChild(drill);
    } else if ((a.pairState === 'refused' || a.pairState === 'warning') && a.reason) {
      // A refusal — blocking (enforced, 'refused') OR non-blocking (advisory, 'warning') — must
      // cite the reviewer's reason here, the canonical per-node attestation surface. An advisory
      // refusal additionally states it does not block, so a warning reads honestly on its own.
      row.appendChild(dom.el('blockquote', 'pan-reason', a.reason));
      if (a.pairState === 'warning') {
        row.appendChild(dom.el('div', 'pan-caveat', 'Advisory rule — non-blocking signal, not a pass and not a clean check.'));
      }
    } else if (a.pairState === 'unverified') {
      row.appendChild(dom.el('div', 'pan-caveat', 'Inputs changed or were never checked — not a stale pass. Run the reviewer to confirm.'));
    }
    return row;
  }

  function relList(title, rels, dir, nav) {
    if (!rels || !rels.length) return null;
    var s = section(title, String(rels.length));
    var ul = dom.el('ul', 'pan-rels');
    for (var i = 0; i < rels.length; i += 1) {
      var r = rels[i];
      var target = dir === 'out' ? r.target : r.source;
      var li = dom.el('li', 'pan-rel');
      li.appendChild(dom.el('span', 'pan-reltype', r.type));
      var link = dom.el('button', 'pan-rellink mono');
      link.type = 'button';
      link.textContent = target;
      link.addEventListener('click', function (t) {
        return function () {
          nav({ view: 'tree', node: t });
        };
      }(target));
      li.appendChild(link);
      ul.appendChild(li);
    }
    s.appendChild(ul);
    return s;
  }

  /**
   * A short, stable attestation digest a reviewer can paste (no datetimes — not recorded).
   * Pinned to the exact committed state it attests: the COMMITTED-lock hash and the git commit
   * ref (from PortalData.meta via the facade). With those two pins a third party can reproduce
   * the verdict set the digest claims; absent a commit ref it states "no commit ref" rather
   * than fabricating one. The per-aspect rows carry each effective aspect's honest pair state,
   * so the digest can never read more-green than the live panel.
   */
  function attestationDigest(node, meta) {
    var m = meta || {};
    var lines = [
      'attestation: ' + node.path + ' (' + node.type + ')',
      'state: ' + node.state + (node.fresh ? ' (source changed since last reviewer pass — not a stale pass)' : ''),
      'commit: ' + (m.commitRef || 'no commit ref'),
      'lock: ' + (m.lockHash || 'no committed lock'),
    ];
    var eff = node.effectiveAspects || [];
    for (var i = 0; i < eff.length; i += 1) {
      lines.push('  ' + eff[i].aspectId + ' [' + eff[i].kind + '] ' + eff[i].pairState);
    }
    return lines.join('\n');
  }

  /**
   * Render the shared inspector panel. `route.node` opens a NODE's attestation (below);
   * `route.aspect` opens a RULE's detail (delegated to the panel-aspect module — the aspect-side
   * mirror). `ctx.navigate` routes the panel's links. When the route names neither, the panel
   * closes. Returns nothing.
   */
  Yg.views.panel = function (panel, route, data, ctx) {
    var nav = ctx && ctx.navigate ? ctx.navigate : function () {};
    dom.clear(panel);
    if (route && route.aspect && !route.node && Yg.panelAspect) {
      panel.classList.add('open');
      Yg.panelAspect(panel, route, data, nav);
      return;
    }
    if (!route || !route.node) {
      panel.classList.remove('open');
      return;
    }
    panel.classList.add('open');

    var node = (data.nodes || []).filter(function (n) {
      return n.path === route.node;
    })[0];
    if (!node) {
      panel.appendChild(dom.el('h3', 'panel-title', route.node));
      panel.appendChild(dom.el('p', 'panel-sub', 'Unknown node.'));
      return;
    }

    // Identity.
    var meta = (data && data.meta) || {};
    var head = dom.el('div', 'pan-head');
    // A close affordance — essential when the panel is a right-overlay sheet on a narrow window,
    // harmless as an extra dismiss on a wide one. Drops the node from the route (panel closes),
    // staying on the current view.
    var close = dom.el('button', 'pan-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close panel');
    close.addEventListener('click', function () {
      nav({ view: route.view || 'overview' });
    });
    head.appendChild(close);
    var title = dom.el('div', 'pan-title');
    title.appendChild(Yg.states.badge(node.state));
    title.appendChild(dom.el('b', null, node.name || node.path));
    head.appendChild(title);
    head.appendChild(dom.el('div', 'pan-path mono', node.path));
    // Two DIFFERENT quantities, each labeled for what it is: `mappingEntryCount` counts
    // mapping DECLARATIONS (a directory, a glob, or an exact path) — never resolved files,
    // so it must never be rendered as a file count. `sourceFileCount` is the real, on-disk
    // answer to "how many files does this node own" — the same exclusion-aware,
    // child-carve-out-aware expansion the node's own source fingerprint uses. One directory
    // entry can cover any number of files, which is exactly why both numbers are shown side
    // by side rather than either one standing in for the other.
    var entryWord = node.mappingEntryCount === 1 ? ' mapping entry' : ' mapping entries';
    var fileWord = node.sourceFileCount === 1 ? ' source file' : ' source files';
    head.appendChild(
      dom.el(
        'div',
        'pan-meta',
        node.type + ' · ' + node.mappingEntryCount + entryWord + ' · ' + node.sourceFileCount + fileWord,
      ),
    );
    if (node.description) head.appendChild(dom.el('p', 'pan-desc', node.description));

    // The file-aware loop: a node whose source changed since the last reviewer pass reads
    // "unverified" here — a banner makes the touched-not-a-pass status explicit on the panel.
    if (node.fresh) {
      var freshBox = dom.el('div', 'pan-fresh ' + Yg.states.cssClass('unverified'));
      freshBox.appendChild(Yg.states.badge('unverified'));
      freshBox.appendChild(dom.el('span', null, 'Source changed since the last reviewer pass — this reads unverified, not a pass. Refresh re-runs the free checks; Approve re-confirms.'));
      head.appendChild(freshBox);
    }

    // Provenance pins — the committed-lock hash + the git commit ref the digest attests to.
    var prov = dom.el('div', 'pan-prov mono');
    prov.appendChild(dom.el('span', 'pan-prov-k', 'commit ' + (meta.commitRef ? meta.commitRef.slice(0, 12) : 'none')));
    prov.appendChild(dom.el('span', 'pan-prov-k', 'lock ' + (meta.lockHash ? meta.lockHash.slice(0, 12) : 'none')));
    head.appendChild(prov);

    var copy = dom.el('button', 'pan-copy');
    copy.type = 'button';
    copy.textContent = 'copy attestation digest';
    copy.setAttribute('aria-label', 'Copy this node’s attestation digest (pins the commit ref and lock hash) to the clipboard');
    copy.addEventListener('click', function () {
      var text = attestationDigest(node, meta);
      try {
        if (navigator && navigator.clipboard) navigator.clipboard.writeText(text);
      } catch (_e) {
        /* clipboard may be unavailable (file://) — degrade silently */
      }
      copy.textContent = 'copied';
    });
    head.appendChild(copy);
    panel.appendChild(head);

    // Effective aspects.
    var eff = node.effectiveAspects || [];
    if (eff.length) {
      var aspSect = section('Effective aspects', String(eff.length));
      for (var i = 0; i < eff.length; i += 1) aspSect.appendChild(aspectRow(eff[i], nav));
      panel.appendChild(aspSect);
    } else {
      // A no-rule node — link to the Type Model so "nothing here" is never terminal.
      var noRule = section('No effective rule here');
      var p = dom.el('p', 'pan-norule', 'Nothing is checking this node — unguarded, not approved. ');
      var link = dom.el('button', 'pan-norule-link');
      link.type = 'button';
      link.textContent = "see what its type could enforce →";
      link.addEventListener('click', function () {
        nav({ view: 'types' });
      });
      p.appendChild(link);
      noRule.appendChild(p);
      panel.appendChild(noRule);
    }

    // Relations both directions.
    var depOn = relList('Depends on', node.relationsOut, 'out', nav);
    if (depOn) panel.appendChild(depOn);
    var depBy = relList('Depended on by', node.relationsIn, 'in', nav);
    if (depBy) panel.appendChild(depBy);

    // When-filtered-out (not-applicable) — its own honest list.
    if (node.notApplicable && node.notApplicable.length) {
      var na = section('Not applicable here (when-filtered)', String(node.notApplicable.length));
      var naUl = dom.el('ul', 'pan-na');
      for (var j = 0; j < node.notApplicable.length; j += 1) {
        var item = node.notApplicable[j];
        var li = dom.el('li', 'pan-na-item');
        li.appendChild(Yg.states.badge('not-applicable'));
        li.appendChild(dom.el('span', 'mono', item.aspectId));
        li.appendChild(dom.el('span', 'pan-na-why', item.why));
        naUl.appendChild(li);
      }
      na.appendChild(naUl);
      panel.appendChild(na);
    }

    // Suppressions with risk flags.
    if (node.suppressions && node.suppressions.length) {
      var supSect = section('Suppressions on this node', String(node.suppressions.length));
      for (var k = 0; k < node.suppressions.length; k += 1) {
        var sup = node.suppressions[k];
        var srow = dom.el('div', 'pan-supp');
        srow.appendChild(Yg.states.badge('suppressed'));
        srow.appendChild(dom.el('span', 'mono', sup.file + ':' + sup.line));
        srow.appendChild(dom.el('span', 'pan-supp-asp mono', sup.aspectId));
        if (sup.risk) srow.appendChild(dom.el('span', 'pan-risk', sup.risk));
        srow.appendChild(dom.el('div', 'pan-supp-reason', '"' + sup.reason + '" — waiver, not a pass.'));
        supSect.appendChild(srow);
      }
      panel.appendChild(supSect);
    }

    // Log WHY timeline (the only datetimed evidence).
    if (node.log && node.log.length) {
      var logSect = section('Why (log)', String(node.log.length));
      for (var l = 0; l < node.log.length; l += 1) {
        var entry = node.log[l];
        var le = dom.el('div', 'pan-log');
        le.appendChild(dom.el('div', 'pan-log-when mono', entry.when));
        le.appendChild(dom.el('div', 'pan-log-body', entry.body));
        logSect.appendChild(le);
      }
      panel.appendChild(logSect);
    }
  };
})();
