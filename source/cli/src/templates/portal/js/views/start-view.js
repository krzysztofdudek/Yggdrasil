/*
 * V9 Start here — the new-joiner on-ramp.
 *
 * A short scripted walk assembled live from the committed graph (§3a V9), so it is rot-proof:
 * every word is derived from the resolved PortalData, never hardcoded. Five plain-language
 * steps: (1) what this system is, (2) the big areas of the codebase, (3) one business process
 * end to end, (4) one component explained, (5) reading the colours (the honest key). The front
 * door of the pro-adoption rebalance.
 *
 * The step is in-view state with no hash grammar of its own, so the wizard re-renders its own
 * stage in place on Next/Back — it never round-trips through the router for the step (the steps
 * that OPEN a real surface — the structure tree, a flow, a node's panel — route normally). Every
 * state treatment (the area dots, the colour key) is read from the one shared honest-state model.
 *
 * Browser globals only — reads the already-resolved PortalData; no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});
  var dom = Yg.dom;
  Yg.views = Yg.views || {};

  var STEP_TITLES = [
    'What this system is',
    'The big areas of this system',
    'One process, end to end',
    'One component, explained',
    'Reading the colours',
  ];

  /** Top-level component nodes (the "big areas") — derived from the graph, never hardcoded. */
  function bigAreas(data) {
    var nodes = data.nodes || [];
    var top = nodes.filter(function (n) {
      return !n.parent;
    });
    // If there is a single synthetic root, descend one level to the real areas.
    if (top.length === 1) {
      var rootPath = top[0].path;
      top = nodes.filter(function (n) {
        return n.parent === rootPath;
      });
    }
    return top.slice(0, 9);
  }

  /**
   * The honest area state — an area is a container, so its badge is the bottom-up
   * rollupState (the worst REAL state anywhere in its subtree). rollupState is already
   * honest for an empty container: with nothing verdict-bearing under it, the rollup is
   * no-rule (unguarded, never green); a refused/unverified descendant bubbles up. We must
   * NOT gate on the node's own `checked` here — that would suppress a real subtree state
   * on a source-less container area (the exact green-over-empty defect).
   */
  function areaState(node) {
    return node.rollupState;
  }

  /** A representative node to explain in step 4: the first checked node with relations, else any. */
  function representativeNode(data) {
    var nodes = data.nodes || [];
    var withRules = nodes.filter(function (n) {
      return n.checked && (n.effectiveAspects || []).length > 0;
    });
    return withRules[0] || nodes.filter(function (n) { return n.mappingEntryCount > 0; })[0] || nodes[0] || null;
  }

  function stepRail(step) {
    var rail = dom.el('div', 'st-steps');
    for (var i = 0; i < 5; i += 1) {
      var seg = dom.el('div', 'st-step' + (i < step ? ' st-step-done' : i === step ? ' st-step-now' : ''));
      rail.appendChild(seg);
    }
    return rail;
  }

  function roadmapChips(step) {
    var box = dom.el('div', 'st-roadmap');
    for (var i = 0; i < 5; i += 1) {
      var chip = dom.el('span', 'st-chip' + (i === step ? ' st-chip-now' : ''), (i + 1) + ' · ' + STEP_TITLES[i]);
      box.appendChild(chip);
    }
    return box;
  }

  // ── Per-step bodies (each derived from live PortalData) ──────────────────────

  function stepWhatIs(data) {
    var c = data.meta.counts;
    var body = dom.el('div');
    body.appendChild(
      dom.el(
        'p',
        'st-lead',
        'This project is guarded by continuous architecture checks. A set of rules describes how the code should be built; a reviewer checks the real code against them and records a verdict. Green means a reviewer actually checked something and it passed — nothing else is green.',
      ),
    );
    var stats = dom.el('div', 'st-areas');
    stats.appendChild(factCard(String(c.nodes), 'components mapped'));
    stats.appendChild(factCard(String(c.aspects), 'rules in the book'));
    stats.appendChild(factCard(String(c.flows), 'business processes'));
    body.appendChild(stats);
    body.appendChild(
      dom.el('p', 'st-lead st-lead-sm', 'Right now ' + c.verified + ' of ' + c.pairsTotal + ' expected checks are verified. The rest are not failures by default — some are simply unchecked or unguarded. You will learn to read that difference by the end of this walk.'),
    );
    return body;
  }

  function factCard(big, label) {
    var card = dom.el('div', 'st-area');
    card.appendChild(dom.el('b', 'st-fact', big));
    card.appendChild(dom.el('span', null, label));
    return card;
  }

  function stepBigAreas(data, nav) {
    var body = dom.el('div');
    body.appendChild(dom.el('p', 'st-lead', 'This codebase is organized into a handful of areas. Each groups the files that do a related job — and each carries its own rules. Here is the map you will be working in.'));
    var areas = bigAreas(data);
    var grid = dom.el('div', 'st-areas');
    for (var i = 0; i < areas.length; i += 1) {
      grid.appendChild(areaCard(areas[i], nav));
    }
    body.appendChild(grid);
    body.appendChild(
      dom.el('p', 'st-lead st-lead-sm', 'The badge on each area is its state. Green means a reviewer checked it and it passed; the grey "no rule" badge means nothing checks it yet — not broken, just unguarded. You will learn the rest of the colours in the last step.'),
    );
    return body;
  }

  function areaCard(node, nav) {
    var state = areaState(node);
    var card = dom.el('button', 'st-area st-area-link');
    card.type = 'button';
    var top = dom.el('div', 'st-area-top');
    top.appendChild(Yg.states.badge(state));
    top.appendChild(dom.el('b', 'mono', node.name || node.path));
    card.appendChild(top);
    card.appendChild(dom.el('span', null, node.description ? shorten(node.description) : node.type));
    card.addEventListener('click', function () {
      nav({ view: 'tree', node: node.path });
    });
    return card;
  }

  function stepOneFlow(data, nav) {
    var body = dom.el('div');
    var flows = data.flows || [];
    var flow = flows[0];
    if (!flow) {
      body.appendChild(dom.el('p', 'st-lead', 'No business processes are defined yet. When they are, this step walks one end to end.'));
      return body;
    }
    body.appendChild(dom.el('p', 'st-lead', 'A "flow" is a real-world process that crosses several components. Here is one, named in plain business language, with the components it touches.'));
    var card = dom.el('div', 'st-flowcard');
    card.appendChild(dom.el('b', null, flow.name));
    if (flow.description) card.appendChild(dom.el('p', 'st-flow-d', flow.description));
    card.appendChild(dom.el('div', 'st-flow-meta', flow.participants.length + ' components take part. A flow is never just green: if nothing checks its components it reads "nothing-checked", and any unverified component makes the whole process need attention.'));
    var open = dom.el('button', 'st-inline-link');
    open.type = 'button';
    open.textContent = 'See this process in full →';
    open.addEventListener('click', function () {
      nav({ view: 'flows', flow: flow.name });
    });
    card.appendChild(open);
    body.appendChild(card);
    return body;
  }

  function stepOneNode(data, nav) {
    var body = dom.el('div');
    var node = representativeNode(data);
    if (!node) {
      body.appendChild(dom.el('p', 'st-lead', 'No components are mapped yet. When they are, this step explains one in full.'));
      return body;
    }
    body.appendChild(dom.el('p', 'st-lead', 'Each component has an identity, the rules in force on it, and what it depends on. Open one and you can read exactly what a reviewer checked — and what is still unguarded.'));
    var card = dom.el('div', 'st-flowcard');
    var top = dom.el('div', 'st-area-top');
    // node.state is already the honest own state — a node with no real verdict-bearing
    // pair is no-rule, never green (the backend `checked` gate handles that), so we render
    // it directly rather than re-gating on `checked`.
    top.appendChild(Yg.states.badge(node.state));
    top.appendChild(dom.el('b', 'mono', node.name || node.path));
    card.appendChild(top);
    if (node.description) card.appendChild(dom.el('p', 'st-flow-d', shorten(node.description)));
    var ruleCount = (node.effectiveAspects || []).length;
    card.appendChild(dom.el('div', 'st-flow-meta', ruleCount > 0 ? ruleCount + ' rule(s) are in force here. Each carries its own honest verdict — verified, refused, or simply not-yet-checked.' : 'No rule is in force here yet — it is unguarded, not approved.'));
    var open = dom.el('button', 'st-inline-link');
    open.type = 'button';
    open.textContent = 'Open this component →';
    open.addEventListener('click', function () {
      nav({ view: 'tree', node: node.path });
    });
    card.appendChild(open);
    body.appendChild(card);
    return body;
  }

  function stepColours() {
    var body = dom.el('div');
    body.appendChild(dom.el('p', 'st-lead', 'This is the whole key. Every colour means exactly one thing, and only one of them is green. Absence of red is not a pass — an unchecked or unguarded surface is its own distinct colour, never green.'));
    var grid = dom.el('div', 'st-key');
    for (var i = 0; i < Yg.states.ORDER.length; i += 1) {
      var state = Yg.states.ORDER[i];
      var item = dom.el('div', 'st-key-item ' + Yg.states.cssClass(state));
      item.appendChild(Yg.states.badge(state));
      var t = dom.el('div', 'st-key-text');
      t.appendChild(dom.el('b', null, Yg.states.label(state)));
      t.appendChild(dom.el('span', null, Yg.states.plain(state)));
      item.appendChild(t);
      grid.appendChild(item);
    }
    body.appendChild(grid);
    return body;
  }

  function shorten(text) {
    var t = String(text).replace(/\s+/g, ' ').trim();
    return t.length > 90 ? t.slice(0, 87) + '…' : t;
  }

  function renderStep(stage, data, nav, step, setStep) {
    dom.clear(stage);

    stage.appendChild(stepRail(step));
    stage.appendChild(dom.el('div', 'st-stepno mono', 'Step ' + (step + 1) + ' of 5'));

    var card = dom.el('div', 'st-card');
    card.appendChild(dom.el('h1', 'st-h1', STEP_TITLES[step]));

    var bodies = [stepWhatIs(data), stepBigAreas(data, nav), stepOneFlow(data, nav), stepOneNode(data, nav), stepColours()];
    card.appendChild(bodies[step]);

    card.appendChild(roadmapChips(step));

    var navRow = dom.el('div', 'st-nav');
    var back = dom.el('button', 'st-btn');
    back.type = 'button';
    back.textContent = '← Back';
    back.disabled = step === 0;
    back.addEventListener('click', function () {
      if (step > 0) setStep(step - 1);
    });
    navRow.appendChild(back);

    var next = dom.el('button', 'st-btn st-btn-primary');
    next.type = 'button';
    if (step < 4) {
      next.textContent = 'Next: ' + STEP_TITLES[step + 1].toLowerCase() + ' →';
      next.addEventListener('click', function () {
        setStep(step + 1);
      });
    } else {
      next.textContent = 'Done — go to the overview';
      next.addEventListener('click', function () {
        nav({ view: 'overview' });
      });
    }
    navRow.appendChild(next);

    var skip = dom.el('button', 'st-skip');
    skip.type = 'button';
    skip.textContent = 'Skip the tour';
    skip.addEventListener('click', function () {
      nav({ view: 'overview' });
    });
    navRow.appendChild(skip);

    card.appendChild(navRow);
    stage.appendChild(card);
  }

  Yg.views.start = function (stage, route, data, ctx) {
    var nav = ctx && ctx.navigate ? ctx.navigate : function () {};
    var frame = dom.el('div', 'st-frame');
    stage.appendChild(frame);

    var step = 0;
    function setStep(s) {
      step = s;
      renderStep(frame, data, nav, step, setStep);
    }
    renderStep(frame, data, nav, step, setStep);
  };
})();
