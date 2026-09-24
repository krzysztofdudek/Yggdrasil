---
id: php-trait-use-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.oop5.traits (E3 in-class trait use, namespace-relative); research 2026-06-15 PART E §E3"
---

## Rule

An in-class trait `use Timestamps;` (or `use Ns\Other;`) is namespace-RELATIVE, unlike
the absolute top-level namespace `use`: in `namespace App` it resolves to `App\Timestamps`
by current-namespace prepend, never global `\Timestamps`. The extractor resolves it so
(and `Ns\Other` to `App\Ns\Other`); neither file exists, so both stay silent —
applying the absolute top-level rule here would be the T6 mis-bind.

## Files

```php path=src/Mixin/Timestamps.php
<?php
namespace App\Mixin;
trait Timestamps {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { use Timestamps; use Ns\Other; }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # in-class trait `use` is namespace-relative (→ `App\Timestamps`, no file) → silent; never `App\Mixin\Timestamps`

## Why

The in-class trait `use` resolves against the current namespace; treating it like the
absolute top-level import would mis-bind, and resolving it correctly finds no file.
