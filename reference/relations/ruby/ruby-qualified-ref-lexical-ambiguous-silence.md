---
id: ruby-qualified-ref-lexical-ambiguous-silence
language: ruby
category: trap
expectation: silence
cites: "Ruby constant lookup — once `A` of `A::B` is found lexically, `B` is looked up only inside that `A`; research 2026-09-24 languages and relations M2 (RB-2)"
---

## Rule

Inside `module Shop; class Cart`, `Billing::Invoice` finds `Billing` as `Shop::Billing`, which exists in-repo, and then looks for `Invoice` only inside `Shop::Billing`. No in-repo file defines `Shop::Billing::Invoice`, so the constant is either defined dynamically or missing (a `NameError`). Ruby never falls back to the top-level `Billing::Invoice` at that point, so neither may the check: a nesting candidate whose first segment exists but whose full name has no definition silences the whole reference.

## Files

```ruby path=src/billing/invoice.rb
module Billing
  class Invoice
  end
end
```

```ruby path=src/shopbilling/billing.rb
module Shop
  module Billing
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

- silence      # `Billing` is Shop::Billing here; Shop::Billing::Invoice has no in-repo definition, so the top-level Billing::Invoice must not be bound

## Why

Falling through to the top-level constant would bind a reference Ruby resolves elsewhere, which is a false edge. Silence is the only answer that cannot be wrong.
