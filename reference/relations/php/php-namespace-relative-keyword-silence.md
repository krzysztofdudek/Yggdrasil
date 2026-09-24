---
id: php-namespace-relative-keyword-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.namespaces.rules Rule 2 (E10 relative namespace\\Foo); research 2026-06-15 PART E §E10"
---

## Rule

A `namespace\Foo` reference (the `namespace` keyword prefix) resolves to the current
namespace + `Foo` (Rule 2) — `App\Foo` in `namespace App`; the import table is not
consulted. The extractor resolves it so, and `src/Foo.php` does not exist, so it is
silent; `App\Sub\Foo` is never a candidate. php-namespace-relative-qualified-edge is the
twin whose target exists.

## Files

```php path=src/Sub/Foo.php
<?php
namespace App\Sub;
class Foo {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m(): namespace\Foo {} }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # `namespace\Foo` resolves to the current namespace (`App\Foo`, no src/Foo.php) → silent

## Why

The `namespace\` keyword binds against the current namespace only; a class of the same
simple name in a sub-namespace is not what it names.
