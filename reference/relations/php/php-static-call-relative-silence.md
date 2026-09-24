---
id: php-static-call-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.oop5.static (E7 static access); research 2026-06-15 PART E §E7"
---

## Rule

A static access on a literal class name with no leading backslash —
`AuditLog::record("x")` — references the namespace-relative class `App\AuditLog`
(Rule 6). The extractor reads the class operand of `::` (never the member name) and
resolves it so; `src/AuditLog.php` does not exist, so it is silent.

## Files

```php path=src/Audit/AuditLog.php
<?php
namespace App\Audit;
class AuditLog {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m() { AuditLog::record("x"); } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # relative `AuditLog::record()` resolves to `App\AuditLog` (no file) → silent

## Why

The class operand names `App\AuditLog`, which has no file; the member name is never
read as a class.
