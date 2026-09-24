---
id: ruby-reopened-external-nested-silence
language: ruby
category: trap
expectation: silence
cites: "Ruby — `module ActiveRecord; class Base` in an initializer reopens the gem's classes; research 2026-09-24 languages and relations M3 (RB-3)"
---

## Rule

A nested reopening `module ActiveRecord; class Base; …; end; end` in an initializer declares the keys `ActiveRecord` and `ActiveRecord::Base` exactly like a genuine definition would, so the root-anchoring guard alone cannot tell it is a monkey-patch. A reopening is not a definition. Constants rooted at Ruby's core classes and at the namespaces of the ubiquitous frameworks (Rails and its `Active*`/`Action*` components, Rack, RSpec, Minitest, Sinatra, Rake, Bundler, Gem) are always external: the check never binds a reference to an in-repo reopening of them. `class ApplicationRecord < ActiveRecord::Base` therefore stays silent.

## Files

```ruby path=config/initializers/ar_ext.rb
module ActiveRecord
  class Base
    def self.soft_delete!; end
  end
end
```

```ruby path=app/models/application_record.rb
class ApplicationRecord < ActiveRecord::Base
  self.abstract_class = true
end
```

## Expect

- silence      # ActiveRecord is a known external namespace; the initializer only reopens ActiveRecord::Base, so the superclass never binds to it

## Why

This was a CI-blocking false edge in the most common file of every Rails app. Other gems' namespaces are still anchored by any in-repo declaration, so a nested reopening of a less common gem stays a known residual gap; the compact form (`module Rack::Handler`) is covered by ruby-reopened-external-constant-silence.
