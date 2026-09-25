/*
 * The glossary — the one place Yggdrasil's words are defined.
 *
 * The portal must be legible to a human who does not speak the engine's vocabulary, so
 * every internal term carries a plain definition that appears as a tooltip wherever the
 * term is shown, and the honest-state legend (state-model.js) reads its explanations from
 * here too. The same entries are the docs site's Glossary page: docs/glossary.md is
 * generated from ENTRIES (a repo test regenerates it and fails on any difference), so the
 * in-app tooltip, the legend and the docs never drift apart.
 *
 * Each entry: `id` (the stable lowercase key the portal looks up, and the docs anchor),
 * `term` (the display name), `group` (the docs section), `def` (the plain definition),
 * optional `not` (words that are NOT used for this — retired synonyms or look-alikes) and
 * optional `see` (the docs page that covers it in depth).
 *
 * Browser globals only — the tooltip is a hover/focus popover built from page DOM; no
 * network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});

  var ENTRIES = [
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
      def: "A declared dependency between two nodes (calls / uses / …). The code's real dependencies must match what's declared.",
      see: '/relations-flows-ports',
    },
    {
      id: 'flow',
      term: 'flow',
      group: 'The graph',
      def: 'A business process that spans several nodes — “place an order”. A rule attached to a flow reaches every node in it.',
      see: '/relations-flows-ports',
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
      not: 'LLM aspect, judgment rule',
      see: '/reviewers',
    },
    {
      id: 'deterministic',
      term: 'script rule',
      group: 'Rules',
      def: 'A rule written as a script (`check.mjs`) that runs on your machine — mechanical, repeatable and free. A script rule has no reviewer.',
      not: 'deterministic aspect, deterministic reviewer',
      see: '/reviewers',
    },
    {
      id: 'bundle',
      term: 'bundle',
      group: 'Rules',
      def: 'A rule with no `content.md` and no `check.mjs`, only `implies:`. It brings in the rules it implies and records no verdict of its own.',
      not: 'aggregating reviewer',
      see: '/aspects#bundling-rules-implies',
    },
    {
      id: 'status',
      term: 'status',
      group: 'Rules',
      def: 'How much a rule’s refusals count: draft, advisory or enforced, set by `status:` in the rule’s own file.',
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
      def: 'A rule whose refusals show as warnings. They never block.',
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
    { id: 'port', term: 'port', group: 'Rules', def: 'This rule crosses in from a named contract this component consumes.' },
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
      def: 'A person’s sign-off — on a waiver’s reason, an advise item, the choice of a reviewer. The `--approve` flag runs a fill; it is not an approval.',
    },
    {
      id: 'drill',
      term: 'drill',
      group: 'Judging',
      def: '`yg drill`: replay a rule’s case corpus to prove it catches what it should. Drilling a reviewer rule calls the reviewer. To focus on one rule’s findings instead, run `yg check --aspect`.',
      not: 'drill into (for yg check --aspect)',
      see: '/cli-reference#yg-drill',
    },
    // ── Coverage ─────────────────────────────────────────────────────────────
    {
      id: 'covered',
      term: 'covered',
      group: 'Coverage',
      def: 'The graph accounts for the file: it is node-owned, type-covered or excluded. Covered says nothing about whether a rule checks it.',
      see: '/configuration#coverage-config',
    },
    {
      id: 'node-owned',
      term: 'node-owned',
      group: 'Coverage',
      def: 'A file some node’s mapping lists.',
      see: '/configuration#coverage-config',
    },
    {
      id: 'type-covered',
      term: 'type-covered file',
      group: 'Coverage',
      def: 'A file no node owns that exactly one classifying type claims. That type’s `per: file` rules enforce it.',
      not: 'type-level lattice, type tier, component-free file',
      see: '/configuration#coverage-config',
    },
    {
      id: 'type-level-coverage',
      term: 'type-level coverage',
      group: 'Coverage',
      def: 'The feature that makes type-covered files, switched by `coverage.type_level`.',
      see: '/configuration#coverage-config',
    },
    {
      id: 'excluded',
      term: 'excluded',
      group: 'Coverage',
      def: 'A file under a `coverage.excluded` root. Yggdrasil ignores it everywhere.',
      see: '/configuration#coverage-config',
    },
    {
      id: 'unmapped',
      term: 'unmapped / uncovered',
      group: 'Coverage',
      def: 'A file the graph does not account for. Under a `coverage.required` root it is an unmapped error; elsewhere an uncovered warning that never blocks.',
      see: '/configuration#coverage-config',
    },
    {
      id: 'no-rule',
      term: 'unguarded',
      group: 'Coverage',
      def: 'Nothing is checking this part. Not broken — just unguarded. Absence of red is not a pass.',
    },
    // ── The lock and waivers ─────────────────────────────────────────────────
    {
      id: 'lock',
      term: 'lock',
      group: 'The lock and waivers',
      def: 'The committed record of reviewer verdicts, beside a local cache of script verdicts. CI re-proves it without a key.',
      see: '/the-lock',
    },
    {
      id: 'waiver',
      term: 'line-scoped waiver',
      group: 'The lock and waivers',
      def: 'A `yg-suppress` marker with a reason. It waives one rule on the lines it covers — a single line, a bracketed range or the whole file — and needs the user’s sign-off.',
      not: 'file-level waiver',
      see: '/reviewers',
    },
    {
      id: 'waived',
      term: 'waived',
      group: 'The lock and waivers',
      def: 'Someone waived a rule here, on purpose, with a reason. Not the same as verified.',
    },
    {
      id: 'suppressed',
      term: 'suppressed',
      group: 'The lock and waivers',
      def: 'A waiver skips a rule on specific lines, with a reason. Waived is not verified.',
    },
    {
      id: 'boundary',
      term: 'live boundary',
      group: 'The lock and waivers',
      def: 'An undeclared code dependency, recomputed live right now — never read from the stored lock.',
    },
    // ── The family ───────────────────────────────────────────────────────────
    {
      id: 'family',
      term: 'family',
      group: 'The family',
      def: 'The Yggdrasil tool family: Yggdrasil, Grain and Horde at the core, with the add-ons Ratatoskr, Urd, Researcher and Jarl. A group of look-alike files is not a family.',
      see: '/family-contracts',
    },
    {
      id: 'law',
      term: 'law',
      group: 'The family',
      def: 'The family’s word for the rules in the graph and the rails that hold every change to them. It is not a separate concept.',
    },
  ];

  // term id -> plain definition. Keyed by a stable lowercase id, not display text.
  // Backticks mark code in the docs page; a tooltip shows the plain text without them.
  var TERMS = {};
  for (var i = 0; i < ENTRIES.length; i += 1) TERMS[ENTRIES[i].id] = ENTRIES[i].def.replace(/`/g, '');

  /** The plain definition for a term id, or null when the term is unknown. */
  function lookup(termId) {
    var key = String(termId || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(TERMS, key) ? TERMS[key] : null;
  }

  /**
   * Wrap a piece of text as a glossary term: a <span class="term"> carrying the plain
   * definition both as a native title and as an aria-label, so the meaning is reachable on
   * hover AND by a screen reader. Falls back to plain text when the term is unknown.
   */
  function term(termId, displayText) {
    var def = lookup(termId);
    var text = displayText === undefined ? String(termId) : displayText;
    if (!def) return Yg.dom.el('span', null, text);
    var node = Yg.dom.el('span', 'term', text);
    node.setAttribute('tabindex', '0');
    node.setAttribute('title', def);
    node.setAttribute('aria-label', text + ': ' + def);
    node.setAttribute('data-term', String(termId).toLowerCase());
    return node;
  }

  Yg.glossary = { lookup: lookup, term: term, entries: ENTRIES, _terms: TERMS };
})();
