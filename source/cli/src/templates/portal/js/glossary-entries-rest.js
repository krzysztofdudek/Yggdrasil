/*
 * The glossary's entries, continued: the groups from Coverage on. glossary-entries.js starts
 * the list and this file appends to it, before glossary.js reads it; see glossary-entries.js
 * for the shape of an entry. Split only to keep each file a focused size.
 *
 * Browser globals only — no network, no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});

  Yg.glossaryEntries = (Yg.glossaryEntries || []).concat([
    // ── Coverage ─────────────────────────────────────────────────────────────
    {
      id: 'covered',
      term: 'covered',
      group: 'Coverage',
      def: 'A node or a type answers for the file: it is node-owned or type-covered. `yg check` counts covered files out of the files not excluded, and names the excluded ones beside them (`3/5 files covered · 4 excluded`); the JSON field `coverage.covered` keeps an older, wider count that adds the excluded files. Covered says nothing about whether a rule checks it.',
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
      id: 'log-entry',
      term: 'log entry',
      group: 'The lock and waivers',
      def: 'Why a component’s own code changed, written with `yg log add`. A component whose type sets `log_required` owes one for each change to its own source — never for a rule, relation, lock or verdict change — and a fill stops before recording anything over a component it would fill that owes one.',
      see: '/the-lock#the-log-gate',
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
  ]);
})();
