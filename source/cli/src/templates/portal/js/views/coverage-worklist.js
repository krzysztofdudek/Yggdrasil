/*
 * Worklist group/member renderer — mirrors the CLI's grouped-section renderer rules:
 * single-severity groups (split upstream), badge from CODE (never the label),
 * per-member Fix/Why only under the divergent flags, whatLines only for
 * perMemberReason codes, node members navigate, file members are named text
 * (no file surface exists — a dead button would be worse than honesty).
 * Coverage blocks render after the groups, exactly like renderUnmappedBlock.
 */
(function () {
  'use strict';
  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;
  Yg.views = Yg.views || {};

  /* Badge state from the issue CODE. unverified-family → unverified glyph; any other
     error → refused glyph; warnings → warning glyph. Never key off the display label.
     hasOwnProperty-guarded: a code literally named 'constructor'/'toString'/etc must not
     read as unverified via the prototype chain (the same bug class check-render-groups.ts's
     glossLabel already guards). */
  var UNVERIFIED_CODES = { unverified: 1, 'prompt-too-large': 1, 'aspect-companion-runtime-error': 1 };
  function badgeState(group) {
    if (group.severity === 'warning') return 'warning';
    return Object.prototype.hasOwnProperty.call(UNVERIFIED_CODES, group.code) ? 'unverified' : 'refused';
  }

  function memberRow(m, group, nav) {
    var row = dom.el('div', 'cov-member');
    if (m.node) {
      var btn = dom.el('button', 'cov-deeplink mono', m.node);
      btn.type = 'button';
      btn.addEventListener('click', function () { nav({ view: 'tree', node: m.node }); });
      row.appendChild(btn);
    } else if (m.file) {
      row.appendChild(dom.el('span', 'mono cov-member-file', m.file));
    }
    if (m.aspectId) row.appendChild(dom.el('span', 'cov-worow-aspect', "aspect '" + m.aspectId + "'"));
    if (group.divergentWhy && m.why) row.appendChild(dom.el('span', 'cov-member-why', 'Why: ' + m.why));
    if (group.divergentNext && m.next) row.appendChild(dom.el('span', 'cov-member-fix', '› fix: ' + m.next));
    if (group.perMemberReason && m.whatLines && m.whatLines.length) {
      row.appendChild(dom.el('span', 'cov-member-what', m.whatLines.join('\n')));
    }
    // The member's own stand-in identifier — carried ONLY when neither the subject
    // (node/file) nor aspectId already distinguishes it (a repo-level finding, where this
    // text IS the entire content; or a subject-bearing member with no aspectId). Mutually
    // exclusive with `whatLines` (the backend never sets both), so nothing double-renders.
    if (m.what) row.appendChild(dom.el('span', 'cov-member-what', m.what));
    return row;
  }

  /**
   * The group header row: severity pill + rule id (+ rulebook link + shared why, when not
   * divergent) + node/file count. Kept as its own flex row so the pill/id/meta stay on one
   * line; members and the shared fix render as its SIBLINGS in `groupRow` below, never as
   * children of this row — nesting them here would squeeze every member into this same
   * non-wrapping flex line (see `.cov-worow` in views.css) crammed to the right of the meta.
   */
  function headerRow(group, nav) {
    var row = dom.el('div', 'cov-worow');
    var st = badgeState(group);
    var pill = dom.el('span', 'cov-pill ' + Yg.states.cssClass(st));
    pill.appendChild(Yg.states.badge(st));
    pill.appendChild(dom.el('span', null, group.severity));
    row.appendChild(pill);
    var id = dom.el('span', 'cov-worow-id');
    id.appendChild(dom.el('b', 'mono', group.rule));
    if (group.aspectId) {
      var link = dom.el('button', 'cov-rulehdr mono');
      link.type = 'button';
      link.textContent = group.aspectId;
      link.setAttribute('aria-label', 'open rule ' + group.aspectId);
      link.addEventListener('click', function () { nav({ view: 'rulebook', aspect: group.aspectId }); });
      id.appendChild(link);
    }
    // A divergent why is NOT a shared reason — `group.why` is only the first member's
    // rationale (group-issues.ts's `sharedWhy`), so printing it here would show one
    // member's reason as the group's, on top of each member's own (already rendered
    // below when `divergentWhy`) — the exact "one component's reason for everyone" this
    // guard must never show. Mirrors check-render-groups.ts's own guard.
    if (!group.divergentWhy && group.why) id.appendChild(dom.el('span', 'cov-worow-reason', group.why));
    row.appendChild(id);
    var meta = dom.el('span', 'cov-worow-meta');
    if (group.nodeCount === 0 && group.fileCount === 0) {
      meta.appendChild(dom.el('span', null, 'repository-level'));
    } else {
      var parts = [];
      if (group.nodeCount > 0) parts.push(group.nodeCount + (group.nodeCount === 1 ? ' node' : ' nodes'));
      if (group.fileCount > 0) parts.push(group.fileCount + (group.fileCount === 1 ? ' file' : ' files'));
      meta.appendChild(dom.el('span', null, parts.join(' · ')));
    }
    row.appendChild(meta);
    return row;
  }

  /**
   * One group: the header row, then every member row, then the shared fix line — the
   * header and the members are SIBLINGS inside this wrapper, never nested inside the
   * header's own flex row (see `headerRow` above). `.cov-worow-wrap` also carries the
   * between-group separator (views.css), so groups stay visually distinct once they
   * hold more than a single header line.
   */
  function groupRow(group, nav) {
    var wrap = dom.el('div', 'cov-worow-wrap');
    wrap.appendChild(headerRow(group, nav));
    for (var i = 0; i < group.members.length; i += 1) wrap.appendChild(memberRow(group.members[i], group, nav));
    if (!group.divergentNext && group.fix) wrap.appendChild(dom.el('span', 'cov-member-fix', '› fix: ' + group.fix));
    return wrap;
  }

  function coverageBlock(block) {
    var el = dom.el('div', 'cov-covblock');
    // Severity conveyed by glyph + word, never colour alone — the same state-model rule
    // the group rows above already honour (state-model.js: "colour + GLYPH + label").
    var st = block.severity === 'error' ? 'refused' : 'warning';
    var pill = dom.el('span', 'cov-pill ' + Yg.states.cssClass(st));
    pill.appendChild(Yg.states.badge(st));
    pill.appendChild(dom.el('span', null, block.severity));
    el.appendChild(pill);
    el.appendChild(dom.el('b', 'mono', block.code));
    el.appendChild(dom.el('span', 'cov-worow-reason', block.why));
    var files = dom.el('div', 'cov-covblock-files mono');
    files.textContent = block.files.join('\n');
    el.appendChild(files);
    if (block.fix) el.appendChild(dom.el('span', 'cov-member-fix', '› fix: ' + block.fix));
    return el;
  }

  Yg.views.coverageWorklist = {
    badgeState: badgeState,
    renderRows: function (stage, data, nav) {
      var card = dom.el('div', 'cov-cardlist');
      var groups = data.worklist || [];
      for (var i = 0; i < groups.length; i += 1) card.appendChild(groupRow(groups[i], nav));
      var cov = data.worklistCoverage || [];
      for (var c = 0; c < cov.length; c += 1) card.appendChild(coverageBlock(cov[c]));
      stage.appendChild(card);
    },
  };
})();
