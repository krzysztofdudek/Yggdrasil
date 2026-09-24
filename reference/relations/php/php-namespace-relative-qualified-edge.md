---
id: php-namespace-relative-qualified-edge
language: php
category: usage-site
expectation: edge
cites: "php.net language.namespaces.rules (qualified names are relative to the current namespace; `namespace\\X` is explicitly relative); research 2026-09-24 m32"
---

## Rule

Inside `namespace App;`, `Model\Id` with no matching import means `App\Model\Id`, and
`namespace\Model\Id` means the same thing spelled explicitly. Both resolve through
PSR-4 like an import. An unqualified class name is resolved the same way (import first,
then current namespace) but only emits an edge when it is not itself imported, since
the import line already carries that edge; a name that would resolve to the global
namespace is left alone, because a global class may be a PHP built-in that is never
autoloaded.

## Files

```php path=src/Model/Id.php
<?php
namespace App\Model;
class Id {}
```

```php path=src/F2/A.php
<?php
namespace App;
class A {
  function f(Model\Id $id) {}
  function g() { return new namespace\Model\Id(); }
}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/F2/A.php:4 -> node:Model      # `Model\Id` in namespace App → App\Model\Id
- src/F2/A.php:5 -> node:Model      # `namespace\Model\Id` → App\Model\Id

## Why

PHP has no fallback for class names, so the namespace-relative reading is the only one;
if its file exists, it is the dependency.
