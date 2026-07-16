import { walk, report } from '@chrisdudek/yg/ast';

// Forbids a shell command built from anything but a static string literal, and any
// child_process call that re-enables the shell (`shell: true`). A dynamically-built
// `exec`/`execSync` command string, or an argv call run through a shell, is a
// provable command-injection surface — use `execFile`/`execFileSync` with an
// argument array instead. errs: under — it fires ONLY on a provably-dynamic
// command or a literal `shell: true`, never on a static-literal exec or a
// `RegExp.prototype.exec` (whose callee is not a child_process binding).

const CP_MODULE_RE = /^(node:)?child_process$/;
const SHELL_EXEC_NAMES = new Set(['exec', 'execSync']);
const SPAWN_FAMILY = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']);

function stringLiteralModule(node) {
  if (!node || (node.type !== 'string' && node.type !== 'template_string')) return undefined;
  const frag = node.namedChildren.find((c) => c.type === 'string_fragment');
  if (frag) return frag.text;
  const t = node.text;
  return t.length >= 2 ? t.slice(1, -1) : '';
}

// Collect, per file, the local bindings that refer to child_process:
//   execBindings   — local names bound to child_process.exec / execSync
//   spawnBindings  — local names bound to ANY spawn-family fn (exec/spawn/execFile/…)
//   namespaces     — local names bound to the whole child_process module
function collectBindings(root) {
  const execBindings = new Set();
  const spawnBindings = new Set();
  const namespaces = new Set();

  walk(root, (node) => {
    // import { exec, execSync as sh } from 'node:child_process'
    // import cp, * as cp2 from 'child_process'
    if (node.type === 'import_statement') {
      const source = node.childForFieldName('source');
      const mod = stringLiteralModule(source);
      if (!mod || !CP_MODULE_RE.test(mod)) return false;
      const clause = node.namedChildren.find((c) => c.type === 'import_clause');
      if (!clause) return false;
      for (const c of clause.namedChildren) {
        if (c.type === 'identifier') namespaces.add(c.text); // default import
        if (c.type === 'namespace_import') {
          const id = c.namedChildren.find((n) => n.type === 'identifier');
          if (id) namespaces.add(id.text);
        }
        if (c.type === 'named_imports') {
          for (const spec of c.namedChildren) {
            if (spec.type !== 'import_specifier') continue;
            const names = spec.namedChildren.filter((n) => n.type === 'identifier');
            const original = names[0]?.text;
            const local = (names[1] ?? names[0])?.text;
            if (original && local && SPAWN_FAMILY.has(original)) {
              spawnBindings.add(local);
              if (SHELL_EXEC_NAMES.has(original)) execBindings.add(local);
            }
          }
        }
      }
      return false;
    }
    // const cp = require('child_process');  /  const { exec } = require('child_process');
    if (node.type === 'variable_declarator') {
      const value = node.childForFieldName('value');
      if (!value || value.type !== 'call_expression') return;
      const callee = value.childForFieldName('function');
      if (!callee || callee.text !== 'require') return;
      const arg = value.childForFieldName('arguments')?.namedChildren?.[0];
      const mod = stringLiteralModule(arg);
      if (!mod || !CP_MODULE_RE.test(mod)) return;
      const name = node.childForFieldName('name');
      if (!name) return;
      if (name.type === 'identifier') namespaces.add(name.text);
      if (name.type === 'object_pattern') {
        for (const p of name.namedChildren) {
          // { exec } or { exec: sh }
          if (p.type === 'shorthand_property_identifier_pattern' && SPAWN_FAMILY.has(p.text)) {
            spawnBindings.add(p.text);
            if (SHELL_EXEC_NAMES.has(p.text)) execBindings.add(p.text);
          }
          if (p.type === 'pair_pattern') {
            const key = p.childForFieldName('key');
            const val = p.childForFieldName('value');
            if (key && SPAWN_FAMILY.has(key.text) && val?.type === 'identifier') {
              spawnBindings.add(val.text);
              if (SHELL_EXEC_NAMES.has(key.text)) execBindings.add(val.text);
            }
          }
        }
      }
    }
  });

  return { execBindings, spawnBindings, namespaces };
}

// Is this call a child_process shell-exec (exec/execSync) via a tracked binding?
function shellExecName(callee, execBindings, namespaces) {
  if (callee.type === 'identifier') return execBindings.has(callee.text) ? callee.text : undefined;
  if (callee.type === 'member_expression') {
    const obj = callee.childForFieldName('object');
    const prop = callee.childForFieldName('property');
    if (obj?.type === 'identifier' && namespaces.has(obj.text) && prop && SHELL_EXEC_NAMES.has(prop.text)) return prop.text;
  }
  return undefined;
}

// Is this call ANY child_process spawn-family call via a tracked binding?
function spawnFamilyCallee(callee, spawnBindings, namespaces) {
  if (callee.type === 'identifier' && spawnBindings.has(callee.text)) return true;
  if (callee.type === 'member_expression') {
    const obj = callee.childForFieldName('object');
    const prop = callee.childForFieldName('property');
    if (obj?.type === 'identifier' && namespaces.has(obj.text) && prop && SPAWN_FAMILY.has(prop.text)) return true;
  }
  return false;
}

// A first arg that is anything OTHER than a plain string literal is dynamic:
// a template WITH substitutions, or a string concatenation. (A bare identifier is
// left alone — it may be a safe constant — keeping the check false-positive-free.)
function isDynamicCommand(arg) {
  if (!arg) return false;
  if (arg.type === 'template_string') return arg.namedChildren.some((c) => c.type === 'template_substitution');
  if (arg.type === 'binary_expression') return arg.childForFieldName('operator')?.text === '+';
  return false;
}

function hasShellTrue(argsNode) {
  if (!argsNode) return false;
  for (const arg of argsNode.namedChildren) {
    if (arg.type !== 'object') continue;
    for (const p of arg.namedChildren) {
      if (p.type !== 'pair') continue;
      const key = p.childForFieldName('key');
      const value = p.childForFieldName('value');
      const keyName = key?.type === 'property_identifier' || key?.type === 'string' ? key.text.replace(/['"]/g, '') : key?.text;
      if (keyName === 'shell' && value?.type === 'true') return true;
    }
  }
  return false;
}

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    const { execBindings, spawnBindings, namespaces } = collectBindings(file.ast.rootNode);
    if (execBindings.size === 0 && spawnBindings.size === 0 && namespaces.size === 0) continue;

    walk(file.ast.rootNode, (node) => {
      if (node.type !== 'call_expression') return;
      const callee = node.childForFieldName('function');
      const argsNode = node.childForFieldName('arguments');
      if (!callee) return;

      const execName = shellExecName(callee, execBindings, namespaces);
      if (execName) {
        const firstArg = argsNode?.namedChildren?.[0];
        if (isDynamicCommand(firstArg)) {
          violations.push(report(file, node,
            `shell command built dynamically and passed to '${execName}' — a template-substituted or concatenated command is a shell-injection surface; use execFile/execFileSync with an argument array instead`));
        }
      }
      if (spawnFamilyCallee(callee, spawnBindings, namespaces) && hasShellTrue(argsNode)) {
        violations.push(report(file, node,
          `child_process call with shell: true re-enables the shell — pass the command and arguments as an argv array without a shell instead`));
      }
    });
  }
  return violations;
}
