---
id: ruby-rake-file-edge
language: ruby
category: import
expectation: edge
cites: "Rake — `.rake` task files are Ruby; `Rakefile`, `Gemfile`, `*.gemspec` and `config.ru` are Ruby too; research 2026-09-24 languages and relations m21 (RB-7)"
---

## Rule

A `.rake` file is plain Ruby loaded by Rake, so it is parsed with the Ruby grammar like a `.rb` file. The same holds for `*.gemspec`, `config.ru` (`.ru`) and the extension-less `Rakefile`, `Gemfile`, `Guardfile` and `Capfile`. A task that requires a model and uses it depends on the model's node.

## Files

```ruby path=lib/tasks/cleanup.rake
require_relative "../../app/models/order"

task :cleanup do
  Order.delete_all
end
```

```ruby path=app/models/order.rb
class Order
end
```

## Expect

- lib/tasks/cleanup.rake:1 -> node:models      # require_relative resolves to app/models/order.rb
- lib/tasks/cleanup.rake:4 -> node:models      # `Order` inside the task block is the top-level class in node models

## Why

Rake tasks commonly reach into models and services. Coverage counted these files as owned while their dependencies were never checked.
