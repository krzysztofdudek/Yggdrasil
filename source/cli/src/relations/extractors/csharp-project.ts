import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * C# PROJECT SCOPING of global usings (M6/M7).
 *
 * A `global using N;` (or `global using A = N.T;`) applies to every file of the PROJECT that
 * declares it — the compilation unit an MSBuild `.csproj` builds — and to nothing else. A
 * repository usually holds several projects (Api, Worker, Domain, Tests…), each with its own
 * `GlobalUsings.cs`. Aggregating every file's global usings repo-wide leaks one project's imports
 * into another: a bare name in Worker that really binds to an external package could bind to a
 * type Api imports globally, a false edge; and two projects defining the same global alias name
 * would collide last-writer-wins, an order-dependent wrong edge.
 *
 * So the project of a C# file is the NEAREST ancestor directory (the file's own directory
 * included, up to the repository root) that contains a `*.csproj`. Global usings and global
 * aliases are aggregated per project and applied only to that project's files. A project also
 * contributes the global usings MSBuild itself generates from its project files:
 *   - `<Using Include="N" />` items (with `Alias="A"` a global alias; `Static="true"` imports
 *     static members and is not a namespace import, so it is skipped), and `<Using Remove="N" />`
 *     removing an earlier item — read from the nearest `Directory.Build.props`, then the
 *     `.csproj` file(s), then the nearest `Directory.Build.targets`, in MSBuild's import order;
 *   - the SDK's implicit usings when `<ImplicitUsings>` is `enable`/`true`: the namespaces the
 *     .NET SDK named by `<Project Sdk="…">` generates. They are external namespaces, so they only
 *     ever bind an in-repo type the repository itself declares inside them (for example an
 *     extension class put in `Microsoft.Extensions.DependencyInjection`, the ASP.NET convention).
 *
 * Files under no `.csproj` at all (loose sources, or a repository that keeps no project files
 * in the tree) share ONE implicit project, which is what the pass did for every file before
 * project scoping — the behaviour for such a layout is unchanged.
 *
 * The XML reading is deliberately narrow — the `<Using>` items and the two properties — and never
 * evaluates MSBuild conditions or imports beyond the two auto-imported `Directory.Build.*` files.
 * An item hidden behind a condition is still read, which can only add a namespace candidate that
 * resolves to nothing unless the namespace really declares the type; it cannot invent an alias
 * collision the compiler would reject.
 */

/** One C# file's own global-using facts (from its cached extract). */
export interface CsharpGlobalFacts {
  /** Repo-relative POSIX path of the `.cs` file. */
  path: string;
  /** Namespace prefixes of the file's own `global using N;` directives. */
  globalPrefixes: readonly string[];
  /** `[alias, target]` pairs of the file's own `global using A = N.T;` directives. */
  globalAliases: Iterable<readonly [string, string]>;
}

/** The project-wide scope injected into a file's candidate assembly. */
export interface CsharpProjectScope {
  /** Every global namespace import of the file's project (declared in sources or in MSBuild). */
  usings: string[];
  /** Every global alias of the file's project; one name may appear with 2+ targets (ambiguous). */
  aliases: Array<[string, string]>;
}

/** The implicit global usings the .NET SDKs generate (MS Learn — "Implicit using directives"). */
const IMPLICIT_USINGS_BASE = [
  'System',
  'System.Collections.Generic',
  'System.IO',
  'System.Linq',
  'System.Net.Http',
  'System.Threading',
  'System.Threading.Tasks',
];
const IMPLICIT_USINGS_BY_SDK = new Map<string, string[]>([
  ['microsoft.net.sdk.web', [
    'System.Net.Http.Json',
    'Microsoft.AspNetCore.Builder',
    'Microsoft.AspNetCore.Hosting',
    'Microsoft.AspNetCore.Http',
    'Microsoft.AspNetCore.Routing',
    'Microsoft.Extensions.Configuration',
    'Microsoft.Extensions.DependencyInjection',
    'Microsoft.Extensions.Hosting',
    'Microsoft.Extensions.Logging',
  ]],
  ['microsoft.net.sdk.worker', [
    'Microsoft.Extensions.Configuration',
    'Microsoft.Extensions.DependencyInjection',
    'Microsoft.Extensions.Hosting',
    'Microsoft.Extensions.Logging',
  ]],
  ['microsoft.net.sdk.blazorwebassembly', [
    'System.Net.Http.Json',
    'Microsoft.AspNetCore.Components.WebAssembly.Hosting',
    'Microsoft.Extensions.Configuration',
    'Microsoft.Extensions.DependencyInjection',
    'Microsoft.Extensions.Logging',
  ]],
]);

interface UsingItem { include: string; alias?: string; isStatic: boolean }

/** The attributes of one XML start tag's attribute text, keys lower-cased. */
function attributes(attrText: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText)) !== null) out.set(m[1].toLowerCase(), (m[2] ?? m[3] ?? '').trim());
  return out;
}

/** The text with XML comments removed. */
function stripComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

/** The last value of `<Name>value</Name>` in the text, or undefined. */
function lastProperty(xml: string, name: string): string | undefined {
  const re = new RegExp(`<${name}\\b[^>]*>([^<]*)</${name}>`, 'gi');
  let value: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) value = m[1].trim();
  return value;
}

/** Apply the `<Using Include|Remove …>` items of one MSBuild file, in document order. */
function applyUsingItems(xml: string, items: UsingItem[]): void {
  const re = /<Using\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = attributes(m[1]);
    const remove = attrs.get('remove');
    if (remove !== undefined) {
      const gone = new Set(remove.split(';').map((s) => s.trim()).filter((s) => s !== ''));
      for (let i = items.length - 1; i >= 0; i--) if (gone.has(items[i].include)) items.splice(i, 1);
      continue;
    }
    const include = attrs.get('include');
    if (include === undefined) continue;
    const alias = attrs.get('alias');
    const isStatic = (attrs.get('static') ?? '').toLowerCase() === 'true';
    for (const name of include.split(';').map((s) => s.trim()).filter((s) => s !== '')) {
      items.push({ include: name, alias: alias === '' ? undefined : alias, isStatic });
    }
  }
}

/**
 * Build the per-file project scope for every C# file. `projectRoot` is the absolute repository
 * root the repo-relative `files[].path` values are relative to. Deterministic: directory listings
 * are sorted, projects are processed in sorted order, and each returned list is in a stable order.
 */
export function buildCsharpProjectScopes(
  projectRoot: string,
  files: readonly CsharpGlobalFacts[],
): Map<string, CsharpProjectScope> {
  const listings = new Map<string, string[]>();
  const list = (dir: string): string[] => {
    const hit = listings.get(dir);
    if (hit !== undefined) return hit;
    let names: string[];
    try {
      names = readdirSync(path.join(projectRoot, dir)).sort();
    } catch {
      names = [];
    }
    listings.set(dir, names);
    return names;
  };
  const read = (rel: string): string => {
    try {
      return stripComments(readFileSync(path.join(projectRoot, rel), 'utf-8'));
    } catch {
      return '';
    }
  };
  /** `dir` and its ancestors up to the root ('.'), nearest first. */
  const ancestors = (dir: string): string[] => {
    // path.posix.dirname never yields ''; it is a fixed point at the root ('.', or '/').
    const out = [dir];
    for (let up = path.posix.dirname(dir); up !== out[out.length - 1]; up = path.posix.dirname(up)) out.push(up);
    return out;
  };
  const projectDirOf = (file: string): string | null => {
    for (const dir of ancestors(path.posix.dirname(file))) {
      if (list(dir).some((n) => n.toLowerCase().endsWith('.csproj'))) return dir;
    }
    return null;
  };
  const nearestFile = (dir: string, basename: string): string | undefined => {
    for (const d of ancestors(dir)) {
      if (list(d).includes(basename)) return d === '.' ? basename : `${d}/${basename}`;
    }
    return undefined;
  };

  // Group the files by project directory (null = the implicit project of csproj-less files).
  const byProject = new Map<string | null, CsharpGlobalFacts[]>();
  for (const f of files) {
    const key = projectDirOf(f.path);
    let group = byProject.get(key);
    if (!group) {
      group = [];
      byProject.set(key, group);
    }
    group.push(f);
  }

  const out = new Map<string, CsharpProjectScope>();
  // Keys are distinct, so the default code-unit sort is a total, deterministic order.
  const keys = [...byProject.keys()].sort();
  for (const key of keys) {
    const group = byProject.get(key)!;
    const usings = new Set<string>();
    const aliases: Array<[string, string]> = [];
    const aliasSeen = new Set<string>();
    const addAlias = (name: string, target: string): void => {
      const k = `${name}\0${target}`;
      if (aliasSeen.has(k)) return;
      aliasSeen.add(k);
      aliases.push([name, target]);
    };

    if (key !== null) {
      const csprojs = list(key)
        .filter((n) => n.toLowerCase().endsWith('.csproj'))
        .map((n) => (key === '.' ? n : `${key}/${n}`));
      const props = nearestFile(key, 'Directory.Build.props');
      const targets = nearestFile(key, 'Directory.Build.targets');
      const ordered = [props, ...csprojs, targets].filter((p): p is string => p !== undefined).map(read);
      // Properties first (MSBuild evaluates every property before any item), last value wins.
      let implicit: string | undefined;
      for (const xml of ordered) implicit = lastProperty(xml, 'ImplicitUsings') ?? implicit;
      const items: UsingItem[] = [];
      if (implicit !== undefined && /^(enable|true)$/i.test(implicit)) {
        let sdk = '';
        for (const xml of ordered) {
          const m = /<Project\b([^>]*)>/i.exec(xml);
          const s = m ? attributes(m[1]).get('sdk') : undefined;
          if (s !== undefined && s !== '') { sdk = s.toLowerCase(); break; }
        }
        for (const ns of [...IMPLICIT_USINGS_BASE, ...(IMPLICIT_USINGS_BY_SDK.get(sdk) ?? [])]) {
          items.push({ include: ns, isStatic: false });
        }
      }
      for (const xml of ordered) applyUsingItems(xml, items);
      for (const it of items) {
        if (it.isStatic) continue;
        if (it.alias !== undefined) addAlias(it.alias, it.include);
        else usings.add(it.include);
      }
    }

    for (const f of group) {
      for (const p of f.globalPrefixes) usings.add(p);
      for (const [name, target] of f.globalAliases) addAlias(name, target);
    }
    const scope: CsharpProjectScope = { usings: [...usings].sort(), aliases };
    for (const f of group) out.set(f.path, scope);
  }
  return out;
}
