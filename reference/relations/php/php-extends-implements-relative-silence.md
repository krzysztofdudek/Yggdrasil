---
id: php-extends-implements-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.oop5.basic (E2 extends/implements); research 2026-06-15 PART E §E2"
---

## Rule

A supertype list `class C extends Base implements Flowable, Other` names class /
interface references without a leading backslash — namespace-relative, so in
`namespace App` they are `App\Base`, `App\Flowable` and `App\Other`. The extractor
resolves them so; none of `src/Base.php`, `src/Flowable.php`, `src/Other.php` exists
(`src/Base/Base.php` is `App\Base\Base`), so all stay silent.

## Files

```php path=src/Base/Base.php
<?php
namespace App\Base;
class Base {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler extends Base implements Flowable, Other {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # relative `extends Base` / `implements Flowable, Other` resolve to `App\Base` etc., which have no file → silent

## Why

The supertype names resolve by PHP's rule to classes with no file; the same-named
`App\Base\Base` is a different class and is never a candidate.
