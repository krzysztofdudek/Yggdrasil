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
      // (c) bracket/subscript access: options['apiKey'] / options["secret"] …
      if (node.type === 'subscript_expression') {
        const obj = node.childForFieldName('object');
        const index = node.childForFieldName('index');
        if (obj && obj.text === 'options' && index && index.type === 'string') {
          const key = index.text.length >= 2 ? index.text.slice(1, -1) : index.text;
          if (CREDENTIAL_RE.test(key)) {
            violations.push(report(file, node,
              `credential '${key}' read from CLI options via bracket access — reviewer keys must come from process.env (API_KEY_ENV), never the parsed flags`));
          }
        }
      }
      // (d) object destructuring from options: const { apiKey } = options; / const { apiKey: k } = options;
      if (node.type === 'variable_declarator') {
        const nameNode = node.childForFieldName('name');
        const valueNode = node.childForFieldName('value');
        if (nameNode && nameNode.type === 'object_pattern' && valueNode && valueNode.type === 'identifier' && valueNode.text === 'options') {
          for (const child of nameNode.namedChildren) {
            // shorthand: `{ apiKey }` → shorthand_property_identifier_pattern 'apiKey'
            if (child.type === 'shorthand_property_identifier_pattern' && CREDENTIAL_RE.test(child.text)) {
              violations.push(report(file, child,
                `credential '${child.text}' read from CLI options via destructuring — reviewer keys must come from process.env (API_KEY_ENV), never the parsed flags`));
            }
            // renamed: `{ apiKey: k }` → pair_pattern key 'apiKey' (property_identifier or string), value is the local name
            if (child.type === 'pair_pattern') {
              const keyNode = child.childForFieldName('key');
              const keyText = keyNode && keyNode.type === 'string' && keyNode.text.length >= 2
                ? keyNode.text.slice(1, -1)
                : keyNode?.text;
              if (keyText && CREDENTIAL_RE.test(keyText)) {
                violations.push(report(file, child,
                  `credential '${keyText}' read from CLI options via destructuring — reviewer keys must come from process.env (API_KEY_ENV), never the parsed flags`));
              }
            }
          }
        }
      }
    });
  }
  return violations;
}

// ACCEPTED LIMIT (deterministic, by design): this check only recognizes DIRECT reads of
// the literal `options` identifier — dot access (b), bracket access (c), and destructuring
// (d). A credential read via an arbitrary alias of the options object, e.g.
//   const o = options; o.apiKey
// or a renamed action parameter that is itself an alias for the parsed options, is NOT
// detected. Catching that requires data-flow / alias tracking across statements, which is
// out of scope for a deterministic, single-pass AST check. This is an accepted bound, not
// a bug — widen it only if a real regression demonstrates the alias pattern is common
// enough to be worth the added complexity (and false-positive risk).
