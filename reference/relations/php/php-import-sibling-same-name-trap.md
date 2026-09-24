---
id: php-import-sibling-same-name-trap
language: php
category: trap
expectation: edge
cites: "php.net language.namespaces.rules (T3 sibling same-name); research 2026-06-15 trap T3"
---

## Rule

When two nodes each declare a type with the SAME simple name in DIFFERENT namespaces,
a `use` import binds ONLY the namespace it names. `use App\Http\Request;` in a file
whose own namespace is `App\Auth` (which could itself hold an `App\Auth\Request`) is
the EXACT FQN `App\Http\Request` — there is no current-namespace prepend on a `use`
operand and no sibling binding. The bare usage `Request` is imported, so PHP binds it
to the import (never the sibling); the extractor skips an imported unqualified usage,
since the import line already carries its edge, so the import can never mis-bind to
the sibling `App\Auth\Request`.

## Files

```php path=src/Http/Request.php
<?php
namespace App\Http;
class Request {}
```

```php path=src/Auth/Request.php
<?php
namespace App\Auth;
class Request {}
```

```php path=src/Auth/Controller.php
<?php
namespace App\Auth;
use App\Http\Request;
class Controller { function m(Request $r) {} }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Auth/Controller.php:3 -> node:Http      # `use App\Http\Request` resolves to src/Http/Request.php (node Http), never the sibling src/Auth/Request.php

## Why

The decisive false-positive class: a same-simple-name type in another namespace must
NOT be chosen over the imported FQN. The exact dotted operand rejects it, and the
imported bare usage adds no edge of its own.
