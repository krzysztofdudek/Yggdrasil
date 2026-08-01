/*
 * V1 Overview — the pro-adoption landing.
 *
 * The first surface on open (empty hash). Never a celebratory checkmark, never the raw graph.
 * It pairs a plain-language verdict (derived live from the counts — honest about what is and
 * is not green) with a "Start here" door to the on-ramp, the residue turned into links (the
 * unguarded surface made clickable, so absence of red is never a pass), and a collapsed
 * "precise picture" preview that opens the full Coverage & Audit ledger (V2). Every state
 * treatment is read from the one shared honest-state model; nothing here invents a green.
 *
 * Browser globals only — reads the already-resolved PortalData; no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;
  Yg.views = Yg.views || {};

  /** A plain-language verdict derived honestly from the live counts. */
  function verdict(c) {
    if (c.errors > 0) {
      return {
        state: c.refused > 0 ? 'refused' : 'unverified',
        head: c.refused > 0 ? 'Some code broke a rule.' : 'Some code is waiting to be checked.',
        sub:
          'A reviewer found ' +
          c.refused +
          ' refusal(s) and ' +
          c.unverified +
          ' thing(s) not yet confirmed against the current code. These block until resolved.',
      };
    }
    if (c.warnings > 0) {
      return {
        state: 'warning',
        head: 'No failures — a few advisories worth a look.',
        sub: c.warnings + ' advisory signal(s) flagged. They do not block; they are worth a look.',
      };
    }
    return {
      state: 'verified',
      head: 'Every checked thing passed against the current code.',
      sub:
        c.verified +
        ' of ' +
        c.pairsTotal +
        ' expected checks are verified. Green means a reviewer actually checked it — but the absence of red is not a pass, so the unguarded surface below is still worth a look.',
    };
  }

  /** A residue link chip that routes somewhere honest (never a dead end of numbers). */
  function residueLink(state, count, text, onClick) {
    var chip = dom.el('button', 'reslink');
    chip.type = 'button';
    chip.appendChild(Yg.states.badge(state));
    chip.appendChild(dom.el('b', null, String(count)));
    chip.appendChild(dom.el('span', null, text));
    chip.appendChild(dom.el('span', 'reslink-arrow', '→'));
    chip.addEventListener('click', onClick);
    return chip;
  }

  /**
   * A chip in the SAME shape as residueLink, for a count that is neither a residue
   * gap nor a pass — a type-covered file has its own real verdict (it may be
   * verified, refused, or unverified), so it must never carry the "no rule"
   * badge (that would repeat the exact miscount this chip exists to correct) or
   * any other state's badge it does not actually hold. A plain neutral mark
   * stands in for the glyph instead of borrowing a state that does not apply.
   */
  function accountedForLink(count, text, onClick) {
    var chip = dom.el('button', 'reslink');
    chip.type = 'button';
    var mark = dom.el('span', 'state-glyph reslink-neutral', '•');
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', 'satisfied by a matched type');
    mark.setAttribute('title', 'Satisfied by matching a classifying type, not a state of its own — see each file\'s real verdict in Coverage & Audit.');
    chip.appendChild(mark);
    chip.appendChild(dom.el('b', null, String(count)));
    chip.appendChild(dom.el('span', null, text));
    chip.appendChild(dom.el('span', 'reslink-arrow', '→'));
    chip.addEventListener('click', onClick);
    return chip;
  }

  /**
   * The file-aware freshness strip — the heartbeat (§0b.1). When any node's source has changed
   * since the last reviewer pass, the landing says so FIRST: a touched file reads "we don't
   * know", and the whole-repo cached green can never render as "you're fine" over it. Each
   * touched node is a chip routing to its attestation panel. Absent any touched node the strip
   * is not shown (no fabricated "all fresh" claim).
   */
  function freshnessStrip(stage, data, nav) {
    var touched = (data.nodes || []).filter(function (n) {
      return n.fresh === true;
    });
    if (!touched.length) return;
    var strip = dom.el('div', 'ov-fresh ' + Yg.states.cssClass('unverified'));
    var head = dom.el('div', 'ov-fresh-head');
    head.appendChild(Yg.states.badge('unverified'));
    head.appendChild(dom.el('b', null, touched.length + (touched.length === 1 ? ' file changed' : ' files changed') + ' since the last reviewer pass'));
    strip.appendChild(head);
    strip.appendChild(dom.el('p', 'ov-fresh-sub', 'These read unverified — not a pass, just “we don’t know” over the new bytes. Whole-repo cached green never overrides a file you just touched. Refresh re-runs the free checks; Approve re-confirms.'));
    var chips = dom.el('div', 'ov-fresh-chips');
    for (var i = 0; i < touched.length && i < 24; i += 1) {
      var n = touched[i];
      var chip = dom.el('button', 'ov-fresh-chip');
      chip.type = 'button';
      chip.setAttribute('aria-label', 'Open ' + n.path + ' (source changed, unverified)');
      chip.appendChild(Yg.states.badge('unverified'));
      chip.appendChild(dom.el('span', 'mono', n.path));
      chip.addEventListener('click', (function (p) {
        return function () {
          nav({ view: 'tree', node: p });
        };
      })(n.path));
      chips.appendChild(chip);
    }
    strip.appendChild(chips);
    stage.appendChild(strip);
  }

  Yg.views.overview = function (stage, route, data, ctx) {
    var c = data.meta.counts;
    var nav = ctx && ctx.navigate ? ctx.navigate : function () {};

    // The file-aware loop heartbeat: surface any touched-but-unverified file at the very top.
    freshnessStrip(stage, data, nav);

    // Plain-language verdict + the Start-here door.
    var hero = dom.el('div', 'ov-hero');
    var v = verdict(c);
    var verdictBox = dom.el('div', 'ov-verdict ' + Yg.states.cssClass(v.state));
    var vhead = dom.el('div', 'ov-verdict-head');
    vhead.appendChild(Yg.states.badge(v.state));
    vhead.appendChild(dom.el('b', null, v.head));
    verdictBox.appendChild(vhead);
    verdictBox.appendChild(dom.el('p', 'ov-verdict-sub', v.sub));
    hero.appendChild(verdictBox);

    var door = dom.el('div', 'ov-door');
    door.appendChild(dom.el('h4', null, 'New here?'));
    door.appendChild(dom.el('p', null, 'A two-minute walk through what this system is and how to read the colours.'));
    var doorBtn = dom.el('button', 'ov-door-link');
    doorBtn.type = 'button';
    doorBtn.appendChild(dom.el('span', null, 'Start here →'));
    doorBtn.addEventListener('click', function () {
      nav({ view: 'start' });
    });
    door.appendChild(doorBtn);
    hero.appendChild(door);
    stage.appendChild(hero);

    // The residue — the honest unguarded surface, made clickable.
    var resLabel = dom.el('div', 'ov-sectlabel', 'The residue worth a look');
    stage.appendChild(resLabel);
    var residue = dom.el('div', 'ov-residue');
    residue.appendChild(
      residueLink('no-rule', c.noRule, 'nodes have no effective rule', function () {
        nav({ view: 'coverage', filter: 'no-rule' });
      }),
    );
    residue.appendChild(
      residueLink('no-rule', c.uncoveredFiles, 'source files unmapped (unguarded)', function () {
        nav({ view: 'coverage', filter: 'uncovered' });
      }),
    );
    residue.appendChild(
      residueLink('suppressed', c.suppressed, 'active waivers', function () {
        nav({ view: 'suppressions' });
      }),
    );
    // A type-covered file left uncoveredFiles above once it gained a matched-type
    // verdict of its own — it must not simply vanish. Surfaced here, distinctly
    // from the residue chips above, so the count is accounted for somewhere on
    // this view rather than merely no-longer-miscounted. Omitted entirely when
    // zero (typeLevel off or no file satisfied this way) — nothing to account for.
    if (c.typeCoveredCount > 0) {
      residue.appendChild(
        accountedForLink(c.typeCoveredCount, 'files satisfied by their matched type, no component of their own', function () {
          nav({ view: 'coverage' });
        }),
      );
    }
    stage.appendChild(residue);

    // The precise-picture preview → opens the full ledger (V2).
    var precise = dom.el('button', 'ov-precise');
    precise.type = 'button';
    precise.appendChild(dom.el('span', 'ov-precise-frac', c.verified + ' / ' + c.pairsTotal));
    precise.appendChild(dom.el('span', 'ov-precise-lbl', 'expected checks verified — open the precise picture'));
    precise.appendChild(dom.el('span', 'reslink-arrow', '→'));
    precise.addEventListener('click', function () {
      nav({ view: 'coverage' });
    });
    stage.appendChild(precise);

    var foot = dom.el('p', 'ov-foot', 'Absence of red is not a pass — green means a reviewer actually checked it and approved against current inputs.');
    stage.appendChild(foot);
  };
})();
