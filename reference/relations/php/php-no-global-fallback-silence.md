---
id: php-no-global-fallback-silence
language: php
category: trap
expectation: silence
cites: "php.net language.namespaces.rules Rule 6 (no class global fallback); research 2026-06-15 trap T1"
---

## Rule

A bare class name `Logger` with no `use` import resolves to `App\Logger` by
current-namespace prepend (Rule 6) — PHP has NO global fallback for classes, so it is
NEVER `\Logger` or `App\Log\Logger`. The extractor resolves it to `App\Logger`, whose
PSR-4 file `src/Logger.php` does not exist, so it is silent; the `Logger` in another
node is never a candidate.

## Files

```php path=src/Log/Logger.php
<?php
namespace App\Log;
class Logger {}
```

```php path=src/Order/Service.php
<?php
namespace App;
class Service { function f(Logger $l) {} }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # bare `Logger` resolves to `App\Logger` (no global fallback, no src/Logger.php) → never `App\Log\Logger` → silent

## Why

There is no class global fallback in PHP; binding a bare name to an unrelated `Logger`
node is the textbook false positive, and applying the real rule cannot produce it.
