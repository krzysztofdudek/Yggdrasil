import path from 'node:path';

/**
 * Resolve a Ruby `require_relative` literal path to a repo-relative POSIX source file,
 * or undefined. Ruby's ONLY file-precise static link.
 *
 * The specifier is the bare string literal as written in the source
 * (`'../services/order_service'`, `'./helper'`, `'sibling'`). `require_relative`
 * always resolves RELATIVE TO THE DIRECTORY of the requiring file (never the load
 * path), so we join the literal onto `dirname(fromFile)`, append `.rb` if the literal
 * has no extension, and POSIX-normalize `..`/`.`. A candidate that escapes the repo
 * root, or that does not exist, yields undefined.
 *
 * `exists(repoRelPosix)` reports whether a candidate file exists in the resolution
 * universe (disk at --approve time; a fixed known-set in unit tests). PURE except
 * through `exists`. No directory listing, no graph access — the owner index downstream
 * maps the resolved file to a node; an unmapped resolved file is simply not a known
 * target (a coverage matter, never a violation).
 *
 * RESOLUTION MISS → undefined. This fail-to-silence is the false-positive guard: a
 * `require` of a gem (handled by the extractor, which only emits `require_relative`),
 * a mis-typed path, or a file not present resolves to nothing and is never flagged.
 *
 * NOTE: Ruby's constant references (superclass, mixin, qualified call, bare constant)
 * carry NO path — they resolve through the shared SymbolTable, never here. Only the
 * `require_relative` PATH hint reaches this resolver.
 */
export function resolveRubyRequireRelative(
  specifier: string,
  fromFile: string,
  exists: (repoRelPosix: string) => boolean,
): string | undefined {
  if (specifier === '') return undefined;

  const fromDir = path.posix.dirname(toPosix(fromFile));
  // Ruby require_relative appends `.rb` automatically; honor an explicit `.rb` too.
  const withExt = /\.rb$/.test(specifier) ? specifier : `${specifier}.rb`;

  const joined = path.posix.join(fromDir, withExt);
  const normalized = path.posix.normalize(joined);
  if (normalized.startsWith('..')) return undefined; // escaped the repo root → miss

  return exists(normalized) ? normalized : undefined;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Root constants that are ALWAYS external to the repository, whatever the repository
 * declares: Ruby's core classes and modules (loaded before any application code, so an
 * in-repo `class String` can only reopen them) and the namespaces of the ubiquitous
 * frameworks and tools whose monkey-patches live in application initializers and `lib/`
 * (`module ActiveRecord; class Base; …`). A reopening is not a definition, and the syntax
 * cannot tell the two apart, so a reference rooted at one of these never binds to an in-repo
 * declaration. The cost is recall inside the Rails, Rack or RSpec repositories themselves,
 * whose own constants are silenced; the gain is that no application ever gets a false edge
 * from `class ApplicationRecord < ActiveRecord::Base` or from `String` in a spec.
 *
 * Other gems' namespaces are not listed: their compact reopenings are caught by the
 * root-anchoring guard, and a nested reopening of an unlisted gem namespace remains a known
 * residual gap.
 */
const RUBY_EXTERNAL_ROOTS: ReadonlySet<string> = new Set([
  // core classes and modules
  'BasicObject', 'Object', 'Kernel', 'Module', 'Class', 'Comparable', 'Enumerable', 'Enumerator',
  'String', 'Symbol', 'Integer', 'Float', 'Numeric', 'Rational', 'Complex', 'Array', 'Hash', 'Range',
  'Regexp', 'MatchData', 'Proc', 'Method', 'UnboundMethod', 'NilClass', 'TrueClass', 'FalseClass',
  'IO', 'File', 'Dir', 'Time', 'Struct', 'Data', 'Thread', 'Fiber', 'Mutex', 'Queue', 'SizedQueue',
  'ConditionVariable', 'Process', 'Signal', 'GC', 'ObjectSpace', 'Marshal', 'Math', 'Random',
  'Encoding', 'Warning', 'Ractor', 'RubyVM', 'TracePoint', 'Binding', 'Set', 'Refinement', 'Errno',
  'ENV', 'ARGV', 'ARGF', 'STDIN', 'STDOUT', 'STDERR',
  // the core exception hierarchy
  'Exception', 'StandardError', 'RuntimeError', 'ArgumentError', 'TypeError', 'NameError',
  'NoMethodError', 'KeyError', 'IndexError', 'StopIteration', 'ClosedQueueError', 'IOError',
  'EOFError', 'SystemExit', 'NotImplementedError', 'ZeroDivisionError', 'FrozenError', 'RangeError',
  'FloatDomainError', 'ScriptError', 'LoadError', 'SyntaxError', 'SecurityError', 'SignalException',
  'Interrupt', 'SystemCallError', 'EncodingError', 'FiberError', 'ThreadError', 'LocalJumpError',
  'RegexpError', 'UncaughtThrowError', 'NoMatchingPatternError', 'NoMatchingPatternKeyError',
  'NoMemoryError', 'SystemStackError',
  // ubiquitous frameworks and tools
  'Rails', 'ActiveRecord', 'ActiveSupport', 'ActiveModel', 'ActiveJob', 'ActiveStorage',
  'ActionController', 'ActionDispatch', 'ActionView', 'ActionMailer', 'ActionCable', 'ActionMailbox',
  'ActionText', 'Arel', 'Rack', 'RSpec', 'Minitest', 'Sinatra', 'Rake', 'Bundler', 'Gem',
]);

/** True when a Ruby constant key (`A::B::C`, leading `::` already stripped) is rooted at a
 *  constant that is always external (see RUBY_EXTERNAL_ROOTS). */
export function isRubyExternalConstant(symbolKey: string): boolean {
  const idx = symbolKey.indexOf('::');
  return RUBY_EXTERNAL_ROOTS.has(idx === -1 ? symbolKey : symbolKey.slice(0, idx));
}

/** ActiveSupport's `underscore` for one constant segment (`HTMLParser` → `html_parser`,
 *  `ApiV1` → `api_v1`): the file/directory name Zeitwerk expects for it. */
export function rubyUnderscore(segment: string): string {
  return segment
    .replace(/([A-Z\d]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}
