---
id: ruby-qualified-mixin-edge
language: ruby
category: nested
expectation: edge
cites: "Ruby Module#include + scope resolution `::` https://docs.ruby-lang.org/en/3.4/syntax/modules_and_classes_rdoc.html ; research PART B §B5; research 2026-09-24 languages and relations M2 (RB-2)"
---

## Rule

A `::`-qualified mixin argument (`include Shared::Loggable`) is NOT absolute unless it is `::`-rooted: its first segment `Shared` is looked up through Module.nesting, so inside `module App; class Widget` the candidates are `App::Widget::Shared::Loggable`, `App::Shared::Loggable`, then the top-level `Shared::Loggable`. No nested `Shared` exists in-repo, so the top-level key resolves through the SymbolTable to its one defining file.

## Files

```ruby path=src/shared/loggable.rb
module Shared
  module Loggable
  end
end
```

```ruby path=src/widgets/widget.rb
module App
  class Widget
    include Shared::Loggable
  end
end
```

## Expect

- src/widgets/widget.rb:3 -> node:shared      # no App::Widget::Shared or App::Shared exists → the top-level Shared::Loggable (node shared)

## Why

A real cross-node mixin dependency nested inside a namespace is kept, and it is bound only after the nearer lexical readings are ruled out, so a sibling namespace with the same name can never be mistaken for it (see ruby-qualified-ref-lexical-shadow-edge).
