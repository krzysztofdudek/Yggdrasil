---
id: php-param-return-property-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.types.declarations (E4 type positions); research 2026-06-15 PART E §E4"
---

## Rule

Class names in parameter, return, and property type positions — `private Repo $r;`,
`function m(Logger $l): Result` — written without a leading backslash are
namespace-relative (including union / intersection / DNF composites and 8.3 typed
constants), here `App\Repo`, `App\Logger`, `App\Result`. The extractor resolves them
so; none has a file, so all stay silent and `App\Dep\Repo` is never a candidate.

## Files

```php path=src/Dep/Repo.php
<?php
namespace App\Dep;
class Repo {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { private Repo $r; function m(Logger $l): Result {} }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # relative `Repo` / `Logger` / `Result` resolve to `App\...`, which have no file → silent

## Why

A relative type hint names the class PHP's rule gives it; here none of them has a
file, so nothing binds.
