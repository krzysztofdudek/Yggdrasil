---
id: php-require-bare-path-silence
language: php
category: dynamic
expectation: silence
cites: "php.net function.include (a relative path is resolved against include_path, then the calling script's directory, then the working directory)"
---

## Rule

A bare `require 'x.php'` or `require './x.php'` is resolved at runtime against
`include_path` and the current working directory, not the file's own directory, so the
same text can name different files depending on how the script was started. A path
built from a variable or a function other than `dirname` is dynamic. All of these stay
silent.

## Files

```php path=app/lib/helpers.php
<?php
function helper() {}
```

```php path=app/legacy/index.php
<?php
require 'lib/helpers.php';
require './../lib/helpers.php';
require $base . '/../lib/helpers.php';
require plugin_dir_path(__FILE__) . '../lib/helpers.php';
```

## Expect

- silence      # include_path/cwd-relative and dynamic paths never produce an edge

## Why

Binding a runtime-resolved path to the includer's directory would be a guess.
