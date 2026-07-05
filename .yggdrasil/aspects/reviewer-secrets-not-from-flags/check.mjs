import { walk, report } from '@chrisdudek/yg/ast';

// A flag / property name that looks like a credential.
const CREDENTIAL_RE = /(api[-_]?)?key|secret|token|password|credential/i;

// Strip a Commander flag spec ("--api-key <x>" | "-k, --api-key [y]") down to
// the long-flag word ("api-key"). Returns '' when no long flag is present.
function longFlagName(spec) {
  const m = spec.match(/--([a-z0-9][a-z0-9-]*)/i);
  return m ? m[1] : '';
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    walk(file.ast.rootNode, (node) => {
      // (a) Commander option registration: .option('--api-key <x>', ...)
      if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function');
        if (fn && fn.type === 'member_expression') {
          const prop = fn.childForFieldName('property');
          if (prop && prop.text === 'option') {
            const args = node.childForFieldName('arguments');
            const first = args && args.namedChildCount > 0 ? args.namedChild(0) : null;
            if (first && (first.type === 'string' || first.type === 'template_string')) {
              const spec = first.text.slice(1, -1); // strip quotes
              const flag = longFlagName(spec);
              if (flag && CREDENTIAL_RE.test(flag)) {
                violations.push(report(file, first,
                  `credential-shaped CLI option '--${flag}' — reviewer keys must come from the provider env var (API_KEY_ENV), never a flag (shell-history hygiene)`));
              }
            }
          }
        }
      }
      // (b) credential read off the parsed options object: options.apiKey / options.secret …
      if (node.type === 'member_expression') {
        const obj = node.childForFieldName('object');
        const prop = node.childForFieldName('property');
        if (obj && obj.text === 'options' && prop && CREDENTIAL_RE.test(prop.text)) {
          violations.push(report(file, node,
            `credential '${prop.text}' read from CLI options — reviewer keys must come from process.env (API_KEY_ENV), never the parsed flags`));
        }
      }
    });
  }
  return violations;
}
