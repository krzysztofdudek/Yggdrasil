---
id: php-catch-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.exceptions (E8 catch / multi-catch); research 2026-06-15 PART E §E8"
---

## Rule

A `catch (DomainError | OtherError $e)` names exception class references without a
leading backslash — namespace-relative (multi-catch since 8.0), so `App\DomainError` and
`App\OtherError`. The extractor resolves them so; neither file exists, so both stay
silent and `App\Err\DomainError` is never a candidate.

## Files

```php path=src/Err/DomainError.php
<?php
namespace App\Err;
class DomainError {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m() { try {} catch (DomainError | OtherError $e) {} } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # relative `catch (DomainError | OtherError ...)` resolve to `App\...`, which have no file → silent

## Why

The caught types resolve by PHP's rule to classes with no file; nothing binds.
