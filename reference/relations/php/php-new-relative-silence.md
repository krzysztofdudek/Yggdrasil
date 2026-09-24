---
id: php-new-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.namespaces.rules Rule 6 (E1 new); research 2026-06-15 PART E §E1"
---

## Rule

`new Timer()` with no leading backslash is a namespace-RELATIVE class reference: in
`namespace App` it resolves to `App\Timer` by current-namespace prepend (Rule 6, no
global fallback). The extractor applies exactly that rule, so the specifier is
`App\Timer`, which PSR-4 maps to `src/Timer.php`. No such file exists, so nothing binds;
the same-named `App\Metrics\Timer` in another node is never considered.

## Files

```php path=src/Metrics/Timer.php
<?php
namespace App\Metrics;
class Timer {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m() { $o = new Timer(); } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # `new Timer()` is namespace-relative (→ `App\Timer`, no src/Timer.php), never `App\Metrics\Timer` → silent

## Why

PHP's own compile-time rule names the class; when its file is absent there is no
dependency to report, and a same-named class elsewhere is never a candidate.
