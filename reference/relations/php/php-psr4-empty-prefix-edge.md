---
id: php-psr4-empty-prefix-edge
language: php
category: import
expectation: edge
cites: "getcomposer.org/doc/04-schema.md#psr-4 (an empty prefix `\"\"` is a fallback directory for any namespace); research 2026-09-24 m34"
---

## Rule

Composer accepts an empty PSR-4 prefix, `"": "src/"`, as a fallback directory for every
namespace: it is tried only when no named prefix matches. The whole FQN becomes the
path under the fallback directory, `App\Model\Id` → `src/App/Model/Id.php`. (The old
code skipped `""`, citing PSR-4, but Composer documents it.)

## Files

```php path=src/App/Model/Id.php
<?php
namespace App\Model;
class Id {}
```

```php path=src/App/F3/A.php
<?php
namespace App\F3;
use App\Model\Id;
class A {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "": "src/" } } }
```

## Expect

- src/App/F3/A.php:3 -> node:Model      # empty prefix → fallback dir src/ → src/App/Model/Id.php (node Model)

## Why

A project using the fallback directory used to resolve nothing at all.
