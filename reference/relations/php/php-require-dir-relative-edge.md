---
id: php-require-dir-relative-edge
language: php
category: import
expectation: edge
cites: "php.net function.include (a path built from `__DIR__` is absolute and does not consult include_path); php.net language.constants.magic (`__DIR__` = dirname(__FILE__)); research 2026-09-24 m30"
---

## Rule

`require`, `require_once`, `include` and `include_once` whose operand is statically
file-relative name one file: `__DIR__ . '/<literal>'`, `dirname(__FILE__) . '/<literal>'`
and `dirname(__DIR__[, n]) . '/<literal>'` (also `dirname(__FILE__, n)`). The literal
must start with `/`, contain no interpolation and be concatenated directly; the path is
joined to the includer's directory (moved up as `dirname` says) and resolves when the
file exists.

## Files

```php path=app/lib/helpers.php
<?php
function helper() {}
```

```php path=app/legacy/index.php
<?php
require_once __DIR__ . '/../lib/helpers.php';
include dirname(__FILE__) . "/../lib/helpers.php";
require dirname(__DIR__) . '/lib/helpers.php';
```

## Expect

- app/legacy/index.php:2 -> node:lib      # __DIR__ . '/../lib/helpers.php' → app/lib/helpers.php (node lib)
- app/legacy/index.php:3 -> node:lib      # dirname(__FILE__) is __DIR__
- app/legacy/index.php:4 -> node:lib      # dirname(__DIR__) moves one directory up

## Why

These paths do not depend on the working directory or `include_path`; they name the
file as precisely as a relative import in any other language.
