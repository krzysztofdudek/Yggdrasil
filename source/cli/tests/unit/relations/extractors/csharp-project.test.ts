import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCsharpProjectScopes, type CsharpGlobalFacts } from '../../../../src/relations/extractors/csharp-project.js';

/** Project scoping of C# global usings (M6/M7): the nearest `.csproj` is the project; global
 *  usings and aliases from sources and from MSBuild `<Using>` items apply only inside it. */
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yg-csproj-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf-8');
  }
  return root;
}

const cs = (p: string, globalPrefixes: string[] = [], globalAliases: Array<[string, string]> = []): CsharpGlobalFacts => ({
  path: p,
  globalPrefixes,
  globalAliases,
});

describe('buildCsharpProjectScopes — project boundaries', () => {
  it('a global using applies to its own project only (nearest .csproj)', () => {
    const root = project({
      'src/api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
      'src/worker/Worker.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
    });
    const scopes = buildCsharpProjectScopes(root, [
      cs('src/api/GlobalUsings.cs', ['Api.Models']),
      cs('src/api/models/Customer.cs'),
      cs('src/worker/SyncJob.cs'),
    ]);
    expect(scopes.get('src/api/models/Customer.cs')!.usings).toEqual(['Api.Models']);
    expect(scopes.get('src/worker/SyncJob.cs')!.usings).toEqual([]);
  });

  it('files under no .csproj share one implicit project (the pre-scoping behaviour)', () => {
    const root = project({});
    const scopes = buildCsharpProjectScopes(root, [cs('src/g/Globals.cs', ['N']), cs('src/c/Use.cs')]);
    expect(scopes.get('src/c/Use.cs')!.usings).toEqual(['N']);
  });

  it('a nested project is its own project, not part of the enclosing one', () => {
    const root = project({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
      'tests/App.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
    });
    const scopes = buildCsharpProjectScopes(root, [cs('Globals.cs', ['App.Core']), cs('tests/T.cs')]);
    expect(scopes.get('Globals.cs')!.usings).toEqual(['App.Core']);
    expect(scopes.get('tests/T.cs')!.usings).toEqual([]);
  });

  it('two projects keep their own same-named global aliases; one project with two targets keeps both (ambiguous)', () => {
    const root = project({
      'b/B.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
      's/S.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
    });
    const scopes = buildCsharpProjectScopes(root, [
      cs('b/G.cs', [], [['Money', 'B.Money']]),
      cs('s/G.cs', [], [['Money', 'S.Money']]),
      cs('loose/x/G.cs', [], [['Money', 'X.Money']]),
      cs('loose/y/G.cs', [], [['Money', 'Y.Money']]),
    ]);
    expect(scopes.get('b/G.cs')!.aliases).toEqual([['Money', 'B.Money']]);
    expect(scopes.get('s/G.cs')!.aliases).toEqual([['Money', 'S.Money']]);
    expect(scopes.get('loose/x/G.cs')!.aliases).toEqual([['Money', 'X.Money'], ['Money', 'Y.Money']]);
  });
});

describe('buildCsharpProjectScopes — MSBuild Using items and implicit usings', () => {
  it('reads <Using Include>, Alias and Static, and honours <Using Remove>', () => {
    const root = project({
      'web/Web.csproj': [
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <!-- <Using Include="Commented.Out" /> -->',
        '  <ItemGroup>',
        '    <Using Include="Shop.Domain;Shop.Shared" />',
        '    <Using Include="Shop.Pricing.Money" Alias="Money" />',
        '    <Using Include="Shop.Core.Guard" Static="true" />',
        '    <Using Remove="Shop.Shared" />',
        '  </ItemGroup>',
        '</Project>',
      ].join('\n'),
    });
    const scope = buildCsharpProjectScopes(root, [cs('web/Page.cs')]).get('web/Page.cs')!;
    expect(scope.usings).toEqual(['Shop.Domain']);
    expect(scope.aliases).toEqual([['Money', 'Shop.Pricing.Money']]);
  });

  it('reads the nearest Directory.Build.props and Directory.Build.targets', () => {
    const root = project({
      'Directory.Build.props': '<Project><ItemGroup><Using Include="Company.Shared" /></ItemGroup></Project>',
      'src/Directory.Build.targets': '<Project><ItemGroup><Using Remove="Company.Shared" /><Using Include="Src.Only" /></ItemGroup></Project>',
      'src/app/App.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
      'lib/Lib.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
    });
    const scopes = buildCsharpProjectScopes(root, [cs('src/app/A.cs'), cs('lib/L.cs')]);
    expect(scopes.get('src/app/A.cs')!.usings).toEqual(['Src.Only']);
    expect(scopes.get('lib/L.cs')!.usings).toEqual(['Company.Shared']);
  });

  it('adds the SDK implicit usings only when <ImplicitUsings> is enabled, per SDK flavour', () => {
    const root = project({
      'web/Web.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup><ItemGroup><Using Remove="System.Net.Http" /></ItemGroup></Project>',
      'lib/Lib.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>',
    });
    const scopes = buildCsharpProjectScopes(root, [cs('web/P.cs'), cs('lib/L.cs')]);
    const web = scopes.get('web/P.cs')!.usings;
    expect(web).toContain('System.Linq');
    expect(web).toContain('Microsoft.Extensions.DependencyInjection');
    expect(web).not.toContain('System.Net.Http'); // removed by the project
    expect(scopes.get('lib/L.cs')!.usings).toEqual([]);
  });
});

describe('buildCsharpProjectScopes — MSBuild reading edge cases', () => {
  it('single-quoted attributes, an item with neither Include nor Remove, an empty Alias, a repeated alias', () => {
    const root = project({
      'App.csproj': [
        "<Project Sdk='Microsoft.NET.Sdk'>",
        "  <ItemGroup><Using Include='Shop.Domain' /><Using Condition='true' /><Using Include='Shop.Pricing' Alias='' /></ItemGroup>",
        '</Project>',
      ].join('\n'),
    });
    const scope = buildCsharpProjectScopes(root, [
      cs('Program.cs', [], [['Money', 'Shop.Pricing.Money']]),
      cs('Other.cs', [], [['Money', 'Shop.Pricing.Money']]),
    ]).get('Program.cs')!;
    expect(scope.usings).toEqual(['Shop.Domain', 'Shop.Pricing']); // an empty Alias is a plain using
    expect(scope.aliases).toEqual([['Money', 'Shop.Pricing.Money']]); // the same alias twice is one alias
  });

  it('ImplicitUsings set in Directory.Build.props takes the SDK from the project file', () => {
    const root = project({
      'Directory.Build.props': '<Project><PropertyGroup><ImplicitUsings>true</ImplicitUsings></PropertyGroup></Project>',
      'svc/Svc.csproj': '<Project Sdk="Microsoft.NET.Sdk.Worker"></Project>',
      'lib/Lib.csproj': '<Project Sdk="Some.Custom.Sdk"></Project>',
    });
    const scopes = buildCsharpProjectScopes(root, [cs('svc/W.cs'), cs('lib/L.cs')]);
    expect(scopes.get('svc/W.cs')!.usings).toContain('Microsoft.Extensions.Hosting');
    expect(scopes.get('lib/L.cs')!.usings).toContain('System.Linq'); // an unknown SDK gets the base set
    expect(scopes.get('lib/L.cs')!.usings).not.toContain('Microsoft.Extensions.Hosting');
  });

  it('an unreadable project directory or project file is treated as empty, never as an error', () => {
    const root = project({ 'p/P.csproj': '<Project />' });
    rmSync(path.join(root, 'p/P.csproj'));
    mkdirSync(path.join(root, 'p/P.csproj')); // a directory named like a project file: unreadable as a file
    const scopes = buildCsharpProjectScopes(root, [cs('p/A.cs', ['X'])]);
    expect(scopes.get('p/A.cs')!.usings).toEqual(['X']);
  });
});
