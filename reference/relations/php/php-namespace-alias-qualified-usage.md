---
id: php-namespace-alias-qualified-usage
language: php
category: usage-site
expectation: edge
cites: "php.net language.namespaces.rules (a qualified name's first segment is translated through the import table, else the current namespace is prepended; classes have no global fallback); research 2026-09-24 m32"
---

## Rule

PHP resolves class names at compile time, from the file alone. In a class position
(`new`, a type, `extends`/`implements`, `::`, an attribute, `instanceof`, `catch`, an
in-class trait `use`), a qualified name without a leading `\` has its first segment
translated through the file's `use` imports (case-insensitively); when no import
matches, the current namespace is prepended. `use App\Model;` imports a namespace, not
a class, so the import itself resolves to no file (there is no `src/Model.php`); the
usages `Model\Id` resolve to `App\Model\Id` and edge.

## Files

```php path=src/Model/Id.php
<?php
namespace App\Model;
class Id {}
```

```php path=src/F1/A.php
<?php
namespace App\F1;
use App\Model;
class A {
  function f(Model\Id $id): Model\Id { return new Model\Id(); }
}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/F1/A.php:5 -> node:Model      # `Model\Id` → alias `Model` = App\Model → App\Model\Id → src/Model/Id.php (node Model)

## Why

The alias table and the namespace are in the file; applying PHP's own rule names
exactly the class PHP loads, and a name with no file behind it stays silent.
