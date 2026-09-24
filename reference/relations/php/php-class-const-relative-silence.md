---
id: php-class-const-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.oop5.basic (E6 ::class literal); research 2026-06-15 PART E §E6"
---

## Rule

`Gateway::class` with no leading backslash is a compile-time class-name literal
resolved against the current namespace + `use` imports (Rule 6) — here `App\Gateway`.
The extractor resolves it so; `src/Gateway.php` does not exist, so it is silent and
`App\Pay\Gateway` is never a candidate.

## Files

```php path=src/Pay/Gateway.php
<?php
namespace App\Pay;
class Gateway {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m() { return Gateway::class; } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # relative `Gateway::class` resolves to `App\Gateway` (no file) → silent

## Why

The literal names `App\Gateway`, which has no file; the same-named class in another
namespace is not what it names.
