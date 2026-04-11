import type { ContextPackage } from '../model/context.js';

export function formatContextMarkdown(pkg: ContextPackage): string {
  let md = '';

  md += `# Context Package: ${pkg.nodeName}\n`;
  md += `# Path: ${pkg.nodePath}\n\n`;
  md += `---\n\n`;

  for (const section of pkg.sections) {
    if (section.layers.length === 0) continue;

    md += `## ${section.key}\n\n`;
    for (const layer of section.layers) {
      md += `### ${layer.label}\n\n`;
      md += layer.content;
      md += `\n\n`;
    }
    md += `---\n\n`;
  }

  // Footer
  md += `Layers: ${pkg.layers.map((l) => l.type).join(', ')}\n`;

  return md;
}
