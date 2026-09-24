---
id: php-psr0-edge
language: php
category: import
expectation: edge
cites: "PSR-0 (namespace separators and `_` in the class name map to directories; the whole FQN is kept under the base directory); getcomposer.org/doc/04-schema.md#psr-0; research 2026-09-24 m34"
---

## Rule

PSR-0 keeps the full FQN under the base directory: `App\Model\Id` with
`"App\\": "src/"` maps to `src/App/Model/Id.php`, and an `_` in the class-name segment
(not in the namespace) is a directory separator too, so `App\Legacy_Report` maps to
`src/App/Legacy/Report.php`. PSR-0 is consulted after PSR-4, and the exactly-one-hit
rule applies to all candidates.

## Files

```php path=src/App/Model/Id.php
<?php
namespace App\Model;
class Id {}
```

```php path=src/App/Legacy/Report.php
<?php
namespace App;
class Legacy_Report {}
```

```php path=src/App/F3/A.php
<?php
namespace App\F3;
use App\Model\Id;
use App\Legacy_Report;
class A {}
```

```json path=composer.json
{ "autoload": { "psr-0": { "App\\": "src/" } } }
```

## Expect

- src/App/F3/A.php:3 -> node:Model      # PSR-0: src/ + App/Model/Id.php
- src/App/F3/A.php:4 -> node:Legacy     # PSR-0: `_` in the class name → src/App/Legacy/Report.php

## Why

Legacy PSR-0 projects used to resolve nothing.
