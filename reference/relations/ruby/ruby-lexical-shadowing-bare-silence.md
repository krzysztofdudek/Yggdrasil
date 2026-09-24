---
id: ruby-lexical-shadowing-bare-silence
language: ruby
category: nested
expectation: silence
cites: "Module.nesting (lexical constant lookup) https://docs.ruby-lang.org/en/3.4/Module.html#method-c-nesting ; research PART C §C4 (C1 guard); research 2026-09-24 languages and relations m19 (RB-5)"
---

## Rule

Inside a class or module body a bare constant resolves lexically FIRST: a bare `Helper` inside `class Order` means `Order::Helper` when that constant exists, and the top-level `Helper` only otherwise. The extractor emits the lexical candidates nearest first (`Order::Helper`, then `Helper`) and the first one with an in-repo definition binds. Here `Order::Helper` is defined in the orders node itself, so the reference is intra-node and the top-level `Helper` owned by the helpers node is never bound.

## Files

```ruby path=src/helpers/helper.rb
class Helper
end
```

```ruby path=src/orders/order_helper.rb
class Order
  class Helper
  end
end
```

```ruby path=src/orders/order.rb
class Order
  def run
    Helper.go
  end
end
```

## Expect

- silence      # bare `Helper` inside `class Order` binds the nearer Order::Helper (node orders, same node) → no edge to the top-level Helper in node helpers

## Why

Binding the bare nested `Helper` to the top-level node's `Helper` would be a false positive whenever an `Order::Helper` is the real target. Lexical candidates, nearest first, give the answer Ruby gives; when the nearer candidate is ambiguous the reference is silenced rather than falling through.
