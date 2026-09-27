/*
 * The glossary's entries — the one place Yggdrasil's words are defined. Data only: glossary.js
 * (loaded right after this file) builds the tooltip lookup from them, the honest-state legend
 * (state-model.js) reads its explanations through it, and docs/glossary.md is generated from
 * them (a repo test regenerates the page and fails on any difference), so the in-app tooltip,
 * the legend and the docs never drift apart. Kept apart from glossary.js so the vocabulary can
 * grow without growing the module that serves it. The groups from Coverage on are in
 * glossary-entries-rest.js, which loads next and appends to the same list.
 *
 * Each entry: `id` (the stable lowercase key the portal looks up, and the docs anchor),
 * `term` (the display name), `group` (the docs section), `def` (the plain definition),
 * optional `token` (the frozen machine token for the term in config, flags and JSON),
 * optional `not` (words that are NOT used for this — retired synonyms or look-alikes) and
 * optional `see` (the docs page that covers it in depth).
 *
 * Browser globals only — no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});

  Yg.glossaryEntries = [
    // ── The graph ────────────────────────────────────────────────────────────
    {
      id: 'node',
      term: 'node (component)',
      group: 'The graph',
      def: 'A component of your system as the graph records it: a directory under `.yggdrasil/model/` whose mapping lists the files it owns. Prose says component; the CLI says node.',
      see: '/nodes',
    },
    {
      id: 'mapping',
      term: 'mapping',
      group: 'The graph',
      def: 'The list of paths a node owns. A file in some node’s mapping is node-owned.',
      see: '/nodes',
    },
    {
      id: 'type',
      term: 'architecture type',
      group: 'The graph',
      def: 'A kind of node declared in `yg-architecture.yaml`. A type with a `when:` predicate is a classifying type: it can claim files by path or content.',
      see: '/nodes',
    },
    {
      id: 'relation',
      term: 'relation',
      group: 'The graph',
      def: "A declared dependency between two nodes (calls / uses / …). Every real code dependency must be declared; a declared relation needs no code behind it.",
      see: '/relations-flows-ports',
    },
    {
      id: 'flow',
      term: 'flow',
      group: 'The graph',
      def: 'A business process that spans several nodes — “place an order”. A rule attached to a flow reaches every node in it.',
      see: '/relations-flows-ports',
    },
    {
      id: 'named-port',
      term: 'port (graph element)',
      group: 'The graph',
      def: 'A named entry to a node, declared under `ports:` with the rules it carries; a relation that names it in `portNames:` enters through it and takes those rules on. Every node also has the implicit `default` port. `yg structure` says a dependency goes through a named port when a relation between the two names one other than `default`.',
      see: '/relations-flows-ports#ports',
    },
    // ── Rules ────────────────────────────────────────────────────────────────
    {
      id: 'aspect',
      term: 'aspect (rule)',
      group: 'Rules',
      def: 'A rule the code must satisfy — e.g. “UI must not import the database”. Prose says rule; the graph and the CLI say aspect.',
      see: '/aspects',
    },
    {
      id: 'rule-kind',
      term: 'rule kind',
      group: 'Rules',
      def: 'How a rule is checked. There are three kinds: a reviewer rule, a script rule and a bundle. The files in the rule’s directory decide the kind; no field sets it.',
      not: 'reviewer kind',
      see: '/aspects',
    },
    {
      id: 'llm',
      term: 'reviewer rule',
      group: 'Rules',
      def: 'A rule written as prose (`content.md`) that the reviewer reads and judges the code against — judgment, and it may cost.',
      token: '`llm` — `reviewer.type` in `yg-aspect.yaml`, `kind` in the JSON output',
      not: 'LLM aspect, judgment rule',
      see: '/reviewers',
    },
    {
      id: 'deterministic',
      term: 'script rule',
      group: 'Rules',
      def: 'A rule written as a script (`check.mjs`) that runs on your machine — mechanical, repeatable and free. A script rule has no reviewer.',
      token: '`deterministic` — `reviewer.type` in `yg-aspect.yaml`, the `--only-deterministic` flag, `kind` and `reviewer` in the JSON output',
      not: 'deterministic aspect, deterministic reviewer',
      see: '/reviewers',
    },
    {
      id: 'bundle',
      term: 'bundle',
      group: 'Rules',
      def: 'A rule with no `content.md` and no `check.mjs`, only `implies:`. It brings in the rules it implies and records no verdict of its own.',
      token: '`aggregate` — `kind` in the JSON output',
      not: 'aggregating reviewer',
      see: '/aspects#bundling-rules-implies',
    },
    {
      id: 'status',
      term: 'status',
      group: 'Rules',
      def: 'How much the refusals of a rule count: draft, advisory or enforced. Set by `status:` on the rule, and raisable — never lowerable — at any site that attaches it; the effective status is the highest.',
      not: 'standing, enforcement level',
      see: '/aspect-status',
    },
    {
      id: 'draft',
      term: 'draft',
      group: 'Rules',
      def: 'A rule parked as not-ready — it is removed from the expected set and verifies nothing.',
      see: '/aspect-status',
    },
    {
      id: 'advisory',
      term: 'advisory',
      group: 'Rules',
      def: 'A rule whose refusals show as warnings. They never block — except a pair whose prompt is too large to judge (`prompt-too-large`), an error at any status.',
      see: '/aspect-status',
    },
    {
      id: 'enforced',
      term: 'enforced',
      group: 'Rules',
      def: 'A rule whose refusals are errors: they fail `yg check` and block CI. The default status.',
      see: '/aspect-status',
    },
    {
      id: 'when-filtered',
      term: 'when-filtered',
      group: 'Rules',
      def: 'A rule was deliberately filtered out here — it does not apply to this node.',
      see: '/conditional-aspects',
    },
    {
      id: 'channel',
      term: 'attach channel',
      group: 'Rules',
      def: 'One of the seven ways a rule reaches a node: its own list, an ancestor, its type, an ancestor’s type, a flow, a port, or another rule’s implies.',
      see: '/aspects#how-a-rule-reaches-your-code',
    },
    // Where a rule comes from — the attach channel onto this component, as the portal labels it.
    { id: 'own', term: 'own', group: 'Rules', def: 'This rule is set directly on this component.' },
    { id: 'ancestor', term: 'ancestor', group: 'Rules', def: 'This rule is inherited from a parent component.' },
    { id: 'own-type', term: 'own type', group: 'Rules', def: 'This rule applies to every component of this type.' },
    { id: 'ancestor-type', term: 'ancestor type', group: 'Rules', def: "Inherited from a parent component's type." },
    { id: 'port', term: 'port', group: 'Rules', def: 'This rule crosses in from a port this component enters through a relation — a named one, or the target’s implicit `default` port.' },
    { id: 'implied', term: 'implied', group: 'Rules', def: 'Pulled in by another rule that includes this one.' },
    // ── Judging ──────────────────────────────────────────────────────────────
    {
      id: 'reviewer',
      term: 'reviewer',
      group: 'Judging',
      def: 'The model configured in the `reviewer:` section of `yg-config.yaml`. It judges reviewer rules, and only those; nothing else is called the reviewer.',
      not: 'judge',
      see: '/reviewers',
    },
    {
      id: 'tier',
      term: 'tier',
      group: 'Judging',
      def: 'The named reviewer setting an aspect uses — which model judges it, and how strictly. Tier means this and nothing else.',
      see: '/configuration',
    },
    {
      id: 'consensus',
      term: 'consensus',
      group: 'Judging',
      def: 'How many times the reviewer voted on a rule — more votes, more confidence in the verdict.',
      see: '/configuration',
    },
    {
      id: 'cost',
      term: 'cost',
      group: 'Judging',
      def: 'A script rule costs nothing; the reviewer may cost a paid API call each time it judges.',
    },
    {
      id: 'pair',
      term: 'pair',
      group: 'Judging',
      def: 'One rule checked against one unit — the thing a verdict is recorded for.',
      see: '/the-lock#pairs-and-units',
    },
    {
      id: 'unit',
      term: 'unit',
      group: 'Judging',
      def: 'What one check covers: a node’s files together for a `per: node` rule, a single file for a `per: file` rule.',
      see: '/the-lock#pairs-and-units',
    },
    {
      id: 'verdict',
      term: 'verdict',
      group: 'Judging',
      def: 'What a check of one pair concluded — passed or refused — bound by hash to the exact inputs it saw.',
      see: '/the-lock',
    },
    {
      id: 'fill',
      term: 'fill',
      group: 'Judging',
      def: 'The run that records verdicts: `yg check --approve`. Script rules run for free; reviewer rules go to the reviewer.',
      not: 'approving run, recording run',
      see: '/cli-reference#yg-check',
    },
    {
      id: 'passed',
      term: 'passed',
      group: 'Judging',
      def: 'The verdict when the code satisfies the rule.',
      token: '`approved` — `verdict` in the JSON output and in the lock',
    },
    {
      id: 'refused',
      term: 'refused',
      group: 'Judging',
      def: 'The code broke the rule — with a reason you can read. Under an enforced rule it is an error; under an advisory one, a warning.',
    },
    {
      id: 'verified',
      term: 'verified',
      group: 'Judging',
      def: 'The rule was checked against the current code and it passed. The only green.',
    },
    {
      id: 'unverified',
      term: 'unverified',
      group: 'Judging',
      def: 'No verdict matches the current code yet — it changed, or it was never checked. Not a pass — just “we don’t know”.',
    },
    {
      id: 'stale',
      term: 'stale',
      group: 'Judging',
      def: 'An unverified pair that has a verdict, recorded over inputs that have since changed. The report calls it unverified, with cause `stale`; the JSON counts it apart from the pairs never judged, so the unverified pairs are `totals.verdicts.unverified` plus `totals.verdicts.stale`.',
      token: '`stale` — `verdict` in the JSON `pairs[]` and `totals.verdicts`, `cause` on an `unverified` finding',
    },
    {
      id: 'finding',
      term: 'finding',
      group: 'Judging',
      def: 'One thing a check reports — about a node, a pair, a file or a repository fact. The error and warning counts on the verdict line count findings, as `totals` in the JSON does.',
      see: '/cli-reference#yg-check',
    },
    {
      id: 'block',
      term: 'block',
      group: 'Judging',
      def: 'Findings the report prints together, under one heading with one `why:` and one `fix:`. Where the two numbers differ, the verdict line says how many blocks hold the findings (`5 errors in 2 blocks`).',
      see: '/cli-reference#yg-check',
    },
    {
      id: 'warning',
      term: 'warning',
      group: 'Judging',
      def: 'An advisory rule flagged this. It does not block — it is signal worth a look, not a failure.',
    },
    {
      id: 'not-applicable',
      term: 'not applicable',
      group: 'Judging',
      def: 'A rule was filtered out here on purpose — an empty cell, distinct from unverified.',
    },
    {
      id: 'approval',
      term: 'approval',
      group: 'Judging',
      def: 'A person’s sign-off — on a waiver’s reason, an advise item, the choice of a reviewer. The `--approve` flag runs a fill; it is not an approval, and running one needs none — a paid fill included, whose cost is always stated with it.',
    },
    {
      id: 'drill',
      term: 'drill',
      group: 'Judging',
      def: '`yg drill`: replay a rule’s case corpus to prove it catches what it should. Drilling a reviewer rule calls the reviewer. To focus on one rule’s findings instead, run `yg check --aspect`.',
      not: 'drill into (for yg check --aspect)',
      see: '/cli-reference#yg-drill',
    }
  ];
})();
