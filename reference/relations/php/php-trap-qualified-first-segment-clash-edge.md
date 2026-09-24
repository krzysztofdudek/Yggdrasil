---
id: php-trap-qualified-first-segment-clash-edge
language: php
category: trap
expectation: edge
cites: "php.net language.namespaces.rules Rule 3/4; research 2026-06-15 trap T5"
---

## Rule

`namespace App\Http; use App\Data\Builder as DB;` — the import edge is the absolute FQN
`App\Data\Builder`. The qualified usages `new DB\QueryBuilder()` (first segment `DB`
import-translated → `App\Data\Builder\QueryBuilder`) and `new Http\Request()`
(current-ns prepend → `App\Http\Http\Request`) would be resolved by exactly those
rules, never by guessing another `Request`. The import never mis-binds.

## Files

```php path=src/Data/Builder.php
<?php
namespace App\Data;
class Builder {}
```

```php path=src/Http/C.php
<?php
namespace App\Http;
use App\Data\Builder as DB;
class C {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Http/C.php:3 -> node:Data      # `use App\Data\Builder as DB;` resolves to src/Data/Builder.php (node Data); the alias `DB` and qualified usages are never targets

## Why

The import operand is the absolute FQN; the first-segment clash lives only in
usage-site qualified names, which resolve through the alias table or the current
namespace, never to a same-named class elsewhere.
