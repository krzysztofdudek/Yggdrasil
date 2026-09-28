import { ISSUE_CODES_TABLE } from './issue-codes-table.js';
import { CLI_REFERENCE_AFTER_CODES, CLI_REFERENCE_BEFORE_CODES } from './cli-reference-page.js';

export const summary =
  'Full yg command reference: check, check --approve, context, node, adopt, aspect-test, drill, impact, tree, aspects, flows, find, log, owner, type-suggest, init, prime, knowledge, schemas, simulate, structure, advise, incident, suppressions, pack, marketplace, portal';

/**
 * The docs page docs/cli-reference.md as a terminal reader gets it: the text
 * before and after the page's issue-code tables is generated from the page
 * (cli-reference-page.ts, `npm run cli-reference:update`), and the tables
 * between them are rendered from the issue-code registry, as the page's own
 * are. There is one hand-written CLI reference, and this topic is it.
 */
export const content = `${CLI_REFERENCE_BEFORE_CODES}${ISSUE_CODES_TABLE}${CLI_REFERENCE_AFTER_CODES}`;
