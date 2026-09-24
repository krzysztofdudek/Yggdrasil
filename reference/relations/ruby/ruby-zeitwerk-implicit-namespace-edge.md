---
id: ruby-zeitwerk-implicit-namespace-edge
language: ruby
category: nested
expectation: edge
cites: "Zeitwerk — implicit namespaces: a directory under an autoload root defines its module (`billing/` ↔ `Billing`); research 2026-09-24 languages and relations m20 (RB-6)"
---

## Rule

Zeitwerk autovivifies `Billing` from the directory `app/models/billing/`, so no file declares `module Billing`, and a compact `class Billing::Invoice` would leave the root unanchored and every reference silenced. A compact declaration anchors its implicit namespaces when its file path follows the Zeitwerk convention for its full name: the file is `…/billing/invoice.rb` for `Billing::Invoice` (each segment underscored). A stub whose file name does not match the constant, such as `server_stub.rb` for `Rack::Handler`, anchors nothing.

## Files

```ruby path=app/models/billing/invoice.rb
class Billing::Invoice < ApplicationRecord
end
```

```ruby path=app/services/checkout.rb
Billing::Invoice.create!(total: 1)
```

## Expect

- app/services/checkout.rb:1 -> node:billing      # the path billing/invoice.rb corroborates Billing::Invoice, which anchors the implicit Billing namespace

## Why

Rails apps written in compact style, or relying on implicit namespaces, had every reference to their namespaced models and services silenced.
