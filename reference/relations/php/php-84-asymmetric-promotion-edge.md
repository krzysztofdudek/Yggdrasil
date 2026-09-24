---
id: php-84-asymmetric-promotion-edge
language: php
category: trap
expectation: edge
cites: "PHP 8.4 asymmetric visibility (`public private(set)`); research 2026-09-24 m8 (tree-sitter-php 0.24.2 turns it into an ERROR node in constructor promotion)"
---

## Rule

The shipped grammar does not know PHP 8.4 asymmetric visibility in a promoted
constructor parameter and wraps `private(set)` in an ERROR node. The error stays local:
the `use` import above the class is outside it and still resolves, so the file keeps
its edge.

## Files

```php path=src/Model/Id.php
<?php
namespace App\Model;
class Id {}
```

```php path=src/Http/Ctl.php
<?php
namespace App\Http;
use App\Model\Id;
final class Ctl {
  public function __construct(public private(set) Id $id) {}
}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Http/Ctl.php:3 -> node:Model      # the import survives the ERROR around `private(set)` → src/Model/Id.php (node Model)

## Why

A newer syntax the grammar cannot read must not cost the file an edge it can read.
