// The annotated example of each file format `yg schemas read <name>` prints
// above the format's field table. The list of formats, their summaries and the
// field tables come from the schema objects the parsers enforce
// (source/cli/src/utils/file-formats*.ts); a test holds the two lists equal.
import * as node from './node.js';
import * as aspect from './aspect.js';
import * as aspectAdapt from './aspect-adapt.js';
import * as architecture from './architecture.js';
import * as config from './config.js';
import * as secrets from './secrets.js';
import * as flow from './flow.js';
import * as pkg from './package.js';
import * as marketplace from './marketplace.js';
import * as packages from './packages.js';

export type SchemaTopic = {
  content: string;
};

export const SCHEMA_TOPICS: Record<string, SchemaTopic> = {
  config: { content: config.content },
  secrets: { content: secrets.content },
  architecture: { content: architecture.content },
  node: { content: node.content },
  aspect: { content: aspect.content },
  'aspect-adapt': { content: aspectAdapt.content },
  flow: { content: flow.content },
  package: { content: pkg.content },
  marketplace: { content: marketplace.content },
  packages: { content: packages.content },
};
