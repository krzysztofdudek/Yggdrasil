---
id: php-qualified-usage-via-alias-edge
language: php
category: usage-site
expectation: edge
cites: "php.net language.namespaces.rules Rule 3 (E11 qualified usage via alias); research 2026-06-15 PART E §E11"
---

## Rule

With `use App\Domain\Models;` the local name `Models` may prefix a qualified usage
`new Models\User()`, whose first segment is translated by the import table to
`App\Domain\Models\User` (Rule 3). The IMPORT line `use App\Domain\Models;` resolves
to the file declaring that FQN (`src/Domain/Models.php`). The extractor also resolves the
qualified usage with the same rule, to `App\Domain\Models\User`, but no
`src/Domain/Models/User.php` exists, so the usage adds nothing: exactly one edge survives
— the import. (php-namespace-alias-qualified-usage is the twin where the usage's class
exists and the namespace import names no file.)

## Files

```php path=src/Domain/Models.php
<?php
namespace App\Domain;
class Models {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
use App\Domain\Models;
class Handler { function m() { $u = new Models\User(); } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Domain      # only the import `use App\Domain\Models` resolves (src/Domain/Models.php, node Domain); the usage `Models\User` names a class with no file → silent

## Why

The import operand is the FQN; the qualified usage is resolved through the alias to
the class PHP loads, which has no file here, so it never becomes a phantom edge.
