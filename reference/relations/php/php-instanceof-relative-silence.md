---
id: php-instanceof-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.operators.type (E5 instanceof); research 2026-06-15 PART E §E5"
---

## Rule

`$x instanceof Timer` with no leading backslash names a namespace-relative class
reference (Rule 6) — `App\Timer`. The extractor resolves it so; `src/Timer.php` does not
exist, so it is silent and never binds to a global or same-named `Timer`.

## Files

```php path=src/Metrics/Timer.php
<?php
namespace App\Metrics;
class Timer {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m($x) { return $x instanceof Timer; } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # relative `instanceof Timer` resolves to `App\Timer` (no file) → silent

## Why

The operand names `App\Timer`, which has no file; nothing binds.
