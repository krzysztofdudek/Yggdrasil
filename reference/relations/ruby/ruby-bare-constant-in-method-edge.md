---
id: ruby-bare-constant-in-method-edge
language: ruby
category: nested
expectation: edge
cites: "Ruby constant lookup — lexical scope (Module.nesting), then the ancestors of the innermost class, then Object; research 2026-09-24 languages and relations m19 (RB-5)"
---

## Rule

A bare constant inside a class or method body is resolved the way Ruby resolves it. The extractor emits the lexical candidates (`OrdersController::Order`, then the top-level `Order`), and the first one with an in-repo definition binds. Two guards keep this free of false edges: a lexical candidate whose name exists but is ambiguous silences the reference, and the top-level fallback is taken only when no in-repo namespace nests a constant of the same name (`Admin::Order`, `BaseController::Order`), because such a constant could reach the reference through the class's ancestors. Here `Order` exists only at the top level, so the controller depends on the models node.

## Files

```ruby path=app/models/order.rb
class Order
end
```

```ruby path=app/controllers/orders_controller.rb
class OrdersController < ApplicationController
  def index
    @orders = Order.where(open: true)
  end
end
```

## Expect

- app/controllers/orders_controller.rb:3 -> node:models      # no OrdersController::Order and no nested Order anywhere, so `Order` is the top-level class in node models

## Why

In a Zeitwerk app nearly every cross-component dependency is a bare constant in a class body. Suppressing them all made the Ruby check miss most real dependencies; lexical resolution recovers them without guessing.
