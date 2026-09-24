---
id: php-psr4-cross-package-duplicate-silence
language: php
category: trap
expectation: silence
cites: "Composer autoload (with two packages claiming one class, the first registered wins); research 2026-09-24 M18"
---

## Rule

When the union is consulted and two packages both provide a file for the class, there
are two distinct hits. Which one Composer loads depends on registration order, so the
resolver stays silent, exactly as for two roots of one prefix
(php-psr4-two-roots-both-hit-ambiguous-silence).

## Files

```php path=packages/b/src/Thing.php
<?php
namespace Acme\Shared;
class Thing {}
```

```php path=packages/c/src/Thing.php
<?php
namespace Acme\Shared;
class Thing {}
```

```php path=packages/a/app/Svc.php
<?php
namespace Acme\A;
use Acme\Shared\Thing;
class Svc {}
```

```json path=packages/a/composer.json
{ "autoload": { "psr-4": { "Acme\\A\\": "app/" } } }
```

```json path=packages/b/composer.json
{ "autoload": { "psr-4": { "Acme\\Shared\\": "src/" } } }
```

```json path=packages/c/composer.json
{ "autoload": { "psr-4": { "Acme\\Shared\\": "src/" } } }
```

## Expect

- silence      # `Acme\Shared\Thing` exists in packages/b and packages/c → two distinct hits → no edge

## Why

Two packages claiming one class is a conflict the static tool must not resolve by
guessing.
