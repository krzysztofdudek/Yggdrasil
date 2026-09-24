---
id: ruby-core-class-reopening-silence
language: ruby
category: builtin
expectation: silence
cites: "Ruby core classes are always loaded, so `class String` in lib/core_ext reopens String; research 2026-09-24 languages and relations M4 (RB-4)"
---

## Rule

Ruby's core classes and modules (`String`, `Hash`, `Array`, `Integer`, `Object`, `Kernel`, `Time`, `Struct`, the exception hierarchy, …) exist before any application code runs, so an in-repo `class String` is always a reopening, never the definition. The check treats every constant rooted at a core name as external: a use of `String` never binds to a `core_ext` file, even when that file is the only in-repo declaration.

## Files

```ruby path=lib/core_ext/string.rb
class String
  def shout = upcase + "!"
end
```

```ruby path=spec/formatter_spec.rb
RSpec.describe "formatter" do
  it "shouts" do
    expect(String.new("a").shout).to eq("A!")
  end
end
```

## Expect

- silence      # String is a core class; lib/core_ext/string.rb reopens it and is never the target of a reference to String

## Why

A single reopening file used to become the unique definition of `String`, so every spec and script that mentioned the class was reported as depending on the core_ext node.
