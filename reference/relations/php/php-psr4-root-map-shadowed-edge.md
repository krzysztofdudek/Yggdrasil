---
id: php-psr4-root-map-shadowed-edge
language: php
category: import
expectation: edge
cites: "Composer autoload; research 2026-09-24 M18 (symfony/symfony-style split monorepo: a root map plus per-package maps)"
---

## Rule

A split monorepo carries a root `composer.json` mapping every package prefix plus a
`composer.json` per package mapping only its own. The package-level map is nearest and
does not know `Acme\B\`, so the union is consulted; the root map and
`packages/b/composer.json` both point `Acme\B\Thing` at the same file, which counts as
one distinct hit.

## Files

```php path=packages/b/lib/Thing.php
<?php
namespace Acme\B;
class Thing {}
```

```php path=packages/a/src/Svc.php
<?php
namespace Acme\A;
use Acme\B\Thing;
class Svc {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "Acme\\A\\": "packages/a/src/", "Acme\\B\\": "packages/b/lib/" } } }
```

```json path=packages/a/composer.json
{ "autoload": { "psr-4": { "Acme\\A\\": "src/" } } }
```

```json path=packages/b/composer.json
{ "autoload": { "psr-4": { "Acme\\B\\": "lib/" } } }
```

## Expect

- packages/a/src/Svc.php:3 -> node:lib      # two maps name the same file packages/b/lib/Thing.php → one distinct hit → edge

## Why

The root map covering both prefixes used to be ignored because a nearer, narrower map
existed.
