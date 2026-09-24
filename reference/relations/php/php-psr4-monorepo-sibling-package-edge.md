---
id: php-psr4-monorepo-sibling-package-edge
language: php
category: import
expectation: edge
cites: "Composer autoload (the root package and every path-repository package register their PSR-4 maps in one autoloader); research 2026-09-24 M18"
---

## Rule

In a monorepo each package has its own `composer.json` mapping only its own prefix. The
nearest `composer.json` is consulted first; when it maps no prefix that resolves the
class, the resolver falls back to the union of every `composer.json` in the repository
(`vendor/` excluded), because at runtime Composer registers all of them in one
autoloader. Across the union the exactly-one-hit rule applies: the class resolves only
when exactly one distinct file matches. `packages/a` imports `Acme\B\Thing`, which only
`packages/b/composer.json` maps.

## Files

```php path=packages/b/src/Thing.php
<?php
namespace Acme\B;
class Thing {}
```

```php path=packages/a/app/Svc.php
<?php
namespace Acme\A;
use Acme\B\Thing;
class Svc { function f(): Thing { return new Thing(); } }
```

```json path=packages/a/composer.json
{ "name": "acme/a", "autoload": { "psr-4": { "Acme\\A\\": "app/" } } }
```

```json path=packages/b/composer.json
{ "name": "acme/b", "autoload": { "psr-4": { "Acme\\B\\": "src/" } } }
```

## Expect

- packages/a/app/Svc.php:3 -> node:src      # nearest map has no `Acme\B\` → repo-wide union → packages/b/src/Thing.php (node src of package b)

## Why

The nearest map used to shadow every other one, so each cross-package `use` was
silently dropped in exactly the layout where those edges matter most.
