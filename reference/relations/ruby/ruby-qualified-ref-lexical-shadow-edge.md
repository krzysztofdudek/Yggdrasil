---
id: ruby-qualified-ref-lexical-shadow-edge
language: ruby
category: nested
expectation: edge
cites: "Ruby constant lookup — the first segment of an unrooted `A::B` is looked up through Module.nesting before Object; research 2026-09-24 languages and relations M2 (RB-2)"
---

## Rule

Only a `::`-rooted reference (`::Billing::Invoice`) is absolute. An unrooted qualified reference `Billing::Invoice` written inside `module Shop; class Cart` looks up its first segment `Billing` lexically: `Shop::Cart::Billing`, then `Shop::Billing`, and only then the top-level `Billing`. Here `Shop::Billing::Invoice` exists, so the reference means it, not the top-level `Billing::Invoice`. The extractor emits the nesting candidates in that order and the first one that binds wins.

## Files

```ruby path=src/billing/invoice.rb
module Billing
  class Invoice
  end
end
```

```ruby path=src/shopbilling/invoice.rb
module Shop
  module Billing
    class Invoice
    end
  end
end
```

```ruby path=src/cart/cart.rb
module Shop
  class Cart
    def checkout
      Billing::Invoice.new
    end
  end
end
```

## Expect

- src/cart/cart.rb:4 -> node:shopbilling      # `Billing` resolves through Module.nesting [Shop::Cart, Shop] to Shop::Billing, so the target is Shop::Billing::Invoice, never the top-level Billing::Invoice

## Why

Treating every qualified reference as absolute produced a wrong-target edge: a false positive for `billing` and a missed dependency on `shopbilling`. Namespaced Rails and gem code (`Api::V1`, `Admin::…`) references sibling namespaces partially qualified all the time.
