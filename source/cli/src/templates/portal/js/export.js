/*
 * Audit export — turn the honest ledger into a portable artifact (CSV + JSON).
 *
 * The compliance deliverable is a real file, not a screenshot (§0b.5): the suppression
 * inventory, the no-rule residue (nodes that own source but carry no effective rule), and the
 * coverage summary are serialized to CSV and JSON and handed to the browser as a download. The
 * download is built entirely in the page from a Blob / data-URI — NO network, so the offline
 * static export can still produce the artifact. Pure string builders (buildSuppressionsCsv /
 * buildResidueCsv / buildCoverageCsv / buildExportJson) are separated from the trigger so they
 * are directly testable and round-trip back to the same rows; nothing here invents a state or a
 * green — it serializes exactly what the honest PortalData already carries.
 *
 * Browser globals only — reads the already-resolved PortalData; no Node.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});

  /** Quote one CSV field: wrap in double-quotes and double any embedded quote (RFC 4180). */
  function csvField(value) {
    var s = value === null || value === undefined ? '' : String(value);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  /** Join an array of row-arrays into a CRLF-terminated CSV string (header row first). */
  function csvRows(rows) {
    return rows
      .map(function (cols) {
        return cols.map(csvField).join(',');
      })
      .join('\r\n');
  }

  /** CSV of the suppression inventory: every active waiver with its resolved risk flag. */
  function buildSuppressionsCsv(data) {
    var rows = [['file', 'line', 'aspect', 'risk', 'reason']];
    var sups = (data.suppressions || []).slice();
    for (var i = 0; i < sups.length; i += 1) {
      var s = sups[i];
      rows.push([s.file, s.line, s.aspectId, s.risk || 'none', s.reason || '']);
    }
    return csvRows(rows);
  }

  /** CSV of the no-rule residue: nodes that own source but carry no effective rule, plus the type-covered and excluded file ledgers. */
  function buildResidueCsv(data) {
    var rows = [['node', 'kind']];
    var res = (data.residue || { noRuleNodes: [], uncoveredFiles: [], typeCovered: [], typeCoveredUncomputable: [], excludedFiles: [] });
    (res.noRuleNodes || []).forEach(function (p) {
      rows.push([p, 'no-rule-node']);
    });
    (res.uncoveredFiles || []).forEach(function (f) {
      rows.push([f, 'uncovered-file']);
    });
    // Only the UNENFORCED type-covered files are a residue item (checked by nothing); an
    // enforced one has a real verdict and belongs in the coverage bar, not this ledger.
    (res.typeCovered || []).forEach(function (t) {
      if (!t.enforced) rows.push([t.path, 'type-covered-no-enforcement (' + t.type + ')']);
    });
    // A file whose matched type's rules an aspect implies cycle stopped from ever resolving is
    // its own, disjoint residue kind — never folded into 'type-covered-no-enforcement' above,
    // which would claim a resolved "nothing applies" fact the cascade never actually reached.
    (res.typeCoveredUncomputable || []).forEach(function (t) {
      rows.push([t.path, 'type-covered-uncomputable (' + t.type + ')']);
    });
    (res.excludedFiles || []).forEach(function (f) {
      rows.push([f, 'excluded-file']);
    });
    return csvRows(rows);
  }

  /**
   * CSV of the coverage summary: each count from the honest ledger, one metric per row.
   * Includes the type-level terms (typeCoveredCount / excludedFiles / typeCoveredUnenforced /
   * typeCoveredUncomputable) so `coveredFiles + typeCoveredCount + uncoveredFiles === totalFiles`
   * is visible and checkable in the exported artifact itself, not only in the live page.
   */
  function buildCoverageCsv(data) {
    var c = data.meta.counts;
    var rows = [['metric', 'value']];
    var keys = [
      'nodes', 'aspects', 'flows', 'pairsTotal', 'pairsLLM', 'pairsDet',
      'verified', 'verifiedDet', 'verifiedLlm', 'refused', 'advisoryRefused', 'unverified', 'noRule', 'draft', 'notApplicable',
      'suppressed', 'coveredFiles', 'uncoveredFiles', 'typeCoveredCount', 'typeCoveredUnenforced', 'typeCoveredUncomputable',
      'excludedFiles', 'totalFiles', 'errors', 'warnings',
    ];
    for (var i = 0; i < keys.length; i += 1) rows.push([keys[i], c[keys[i]]]);
    return rows.length ? csvRows(rows) : '';
  }

  /**
   * The combined JSON export object: provenance (project, generation time, lock hash, commit
   * ref) + the three audit tables. Round-trips back to the same rows; never collapses a state.
   */
  function buildExportJson(data) {
    var c = data.meta.counts;
    return {
      provenance: {
        project: data.meta.projectName,
        generatedAt: data.meta.generatedAt,
        lockHash: data.meta.lockHash,
        commitRef: data.meta.commitRef,
        schemaSupported: data.meta.schemaSupported,
      },
      coverage: c,
      suppressions: (data.suppressions || []).slice(),
      residue: data.residue || { noRuleNodes: [], uncoveredFiles: [], typeCovered: [], typeCoveredUncomputable: [], excludedFiles: [] },
    };
  }

  /**
   * Hand `content` to the browser as a download named `filename`, type `mime`. Built from a
   * Blob + object URL when available, else a data: URI — both are in-page, NO network, so the
   * offline static export still produces the artifact. Degrades silently when neither the
   * anchor download nor URL APIs exist (a constrained sandbox); returns true on a real trigger.
   */
  function download(filename, content, mime) {
    try {
      var doc = window.document;
      var a = doc.createElement('a');
      if (typeof a.click !== 'function' && !('download' in a)) return false;
      var href = null;
      if (window.URL && typeof window.URL.createObjectURL === 'function' && typeof window.Blob === 'function') {
        href = window.URL.createObjectURL(new window.Blob([content], { type: mime }));
      } else {
        href = 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(content);
      }
      a.setAttribute('href', href);
      a.setAttribute('download', filename);
      // Append so a real browser fires the navigation; removed straight after.
      if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(a);
      a.click();
      if (doc.body && typeof doc.body.removeChild === 'function') doc.body.removeChild(a);
      if (href && href.indexOf('blob:') === 0 && window.URL.revokeObjectURL) {
        window.URL.revokeObjectURL(href);
      }
      return true;
    } catch (_e) {
      return false;
    }
  }

  Yg.exporter = {
    buildSuppressionsCsv: buildSuppressionsCsv,
    buildResidueCsv: buildResidueCsv,
    buildCoverageCsv: buildCoverageCsv,
    buildExportJson: buildExportJson,
    download: download,
    // Convenience triggers used by the views (suppressions / coverage). Each builds the content
    // and offers the download; honest filenames carry the project name when present.
    exportSuppressionsCsv: function (data) {
      return download(slug(data) + '-suppressions.csv', buildSuppressionsCsv(data), 'text/csv');
    },
    exportResidueCsv: function (data) {
      return download(slug(data) + '-residue.csv', buildResidueCsv(data), 'text/csv');
    },
    exportCoverageCsv: function (data) {
      return download(slug(data) + '-coverage.csv', buildCoverageCsv(data), 'text/csv');
    },
    exportJson: function (data) {
      return download(slug(data) + '-audit.json', JSON.stringify(buildExportJson(data), null, 2), 'application/json');
    },
  };

  /** A filesystem-safe slug from the project name (fallback 'portal'). */
  function slug(data) {
    var name = (data.meta && data.meta.projectName) || 'portal';
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'portal';
  }
})();
