---
id: php-enum-case-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.enumerations (enum case is a member; 8.1); research 2026-06-15 PART E §E13"
---

## Rule

An enum-case access `Suit::Hearts` with no leading backslash is a member access on the
namespace-relative enum class `App\Suit` (Rule 6) — the case `Hearts` is a member, not a
separate type, and the extractor reads only the class operand of `::`. `App\Suit` maps to
`src/Suit.php`, which does not exist, so it is silent; treating the case as a separate
`Hearts` type would be a false positive.

## Files

```php path=src/Enums/Suit.php
<?php
namespace App\Enums;
enum Suit { case Hearts; case Spades; }
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m() { return Suit::Hearts; } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # relative `Suit::Hearts` resolves to `App\Suit` (no file); the case is a member, not a type → silent

## Why

Only the class operand of `::` is a class reference; here it names `App\Suit`, which
has no file, so nothing binds.
