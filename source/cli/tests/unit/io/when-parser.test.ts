import { describe, it, expect } from 'vitest';
import { parseWhen, parseAspectAttachment } from '../../../src/utils/when-parser.js';

describe('parseWhen — error paths', () => {
  it('rejects empty when mapping', () => {
    expect(() => parseWhen({}, 'ctx')).toThrow(/when mapping must not be empty/);
  });

  it('rejects mixing boolean and atomic at same level', () => {
    expect(() => parseWhen({ all_of: [{ node: { type: 'x' } }], node: { type: 'y' } }, 'ctx'))
      .toThrow(/cannot mix boolean operators with atomic clauses/);
  });

  it('rejects multiple boolean operators at same level', () => {
    expect(() => parseWhen({ all_of: [{ node: { type: 'x' } }], any_of: [{ node: { type: 'y' } }] }, 'ctx'))
      .toThrow(/at most one boolean operator at a level/);
  });
});

describe('parseBoolean — error paths', () => {
  it('rejects any_of non-array', () => {
    expect(() => parseWhen({ any_of: 'x' }, 'ctx')).toThrow(/'any_of' must be an array/);
  });

  it('rejects empty all_of array', () => {
    expect(() => parseWhen({ all_of: [] }, 'ctx')).toThrow(/'all_of' array must not be empty/);
  });

  it('rejects empty any_of array', () => {
    expect(() => parseWhen({ any_of: [] }, 'ctx')).toThrow(/'any_of' array must not be empty/);
  });
});

describe('parseRelationClause — error paths', () => {
  it('rejects empty relations mapping', () => {
    expect(() => parseWhen({ relations: {} }, 'ctx')).toThrow(/relations mapping must not be empty/);
  });

  it('rejects non-object relations mapping', () => {
    expect(() => parseWhen({ relations: 'calls' }, 'ctx'))
      .toThrow(/relations must be a YAML mapping keyed by relation type/);
  });
});

describe('parseRelationMatch — error paths', () => {
  it('rejects non-object relation match', () => {
    expect(() => parseWhen({ relations: { calls: 'something' } }, 'ctx'))
      .toThrow(/must be a YAML mapping/);
  });

  it('rejects unknown field in relation match', () => {
    expect(() => parseWhen({ relations: { calls: { foo: 'bar' } } }, 'ctx'))
      .toThrow(/unknown field 'foo'/);
  });

  it('rejects empty relation match object (no required fields)', () => {
    expect(() => parseWhen({ relations: { calls: {} } }, 'ctx'))
      .toThrow(/at least one of target_type, target, consumes_port must be present/);
  });

  it('rejects non-string target_type', () => {
    expect(() => parseWhen({ relations: { calls: { target_type: 42 } } }, 'ctx'))
      .toThrow(/target_type must be a non-empty string/);
  });

  it('rejects empty target_type', () => {
    expect(() => parseWhen({ relations: { calls: { target_type: '  ' } } }, 'ctx'))
      .toThrow(/target_type must be a non-empty string/);
  });

  it('rejects non-string target', () => {
    expect(() => parseWhen({ relations: { calls: { target: null } } }, 'ctx'))
      .toThrow(/target must be a non-empty string/);
  });

  it('rejects empty target', () => {
    expect(() => parseWhen({ relations: { calls: { target: '' } } }, 'ctx'))
      .toThrow(/target must be a non-empty string/);
  });

  it('rejects non-string consumes_port', () => {
    expect(() => parseWhen({ relations: { calls: { consumes_port: 0 } } }, 'ctx'))
      .toThrow(/consumes_port must be a non-empty string/);
  });

  it('rejects empty consumes_port', () => {
    expect(() => parseWhen({ relations: { calls: { consumes_port: '  ' } } }, 'ctx'))
      .toThrow(/consumes_port must be a non-empty string/);
  });

  it('accepts valid target field', () => {
    const result = parseWhen({ relations: { calls: { target: 'some/node' } } }, 'ctx');
    expect(result).toEqual({ relations: { calls: { target: 'some/node' } } });
  });

  it('accepts valid consumes_port field', () => {
    const result = parseWhen({ relations: { calls: { consumes_port: 'my-port' } } }, 'ctx');
    expect(result).toEqual({ relations: { calls: { consumes_port: 'my-port' } } });
  });
});

describe('parseDescendantsClause — error paths', () => {
  it('rejects non-object descendants', () => {
    expect(() => parseWhen({ descendants: 'handler' }, 'ctx'))
      .toThrow(/descendants must be a YAML mapping/);
  });

  it('rejects unknown field in descendants', () => {
    expect(() => parseWhen({ descendants: { foo: 'bar' } }, 'ctx'))
      .toThrow(/unknown field 'foo'/);
  });

  it('rejects empty descendants object', () => {
    expect(() => parseWhen({ descendants: {} }, 'ctx'))
      .toThrow(/at least one of relations, type, has_port must be present/);
  });

  it('rejects non-string type in descendants', () => {
    expect(() => parseWhen({ descendants: { type: 99 } }, 'ctx'))
      .toThrow(/type must be a non-empty string/);
  });

  it('rejects empty type in descendants', () => {
    expect(() => parseWhen({ descendants: { type: '' } }, 'ctx'))
      .toThrow(/type must be a non-empty string/);
  });

  it('rejects non-string has_port in descendants', () => {
    expect(() => parseWhen({ descendants: { has_port: false } }, 'ctx'))
      .toThrow(/has_port must be a non-empty string/);
  });

  it('rejects empty has_port in descendants', () => {
    expect(() => parseWhen({ descendants: { has_port: '   ' } }, 'ctx'))
      .toThrow(/has_port must be a non-empty string/);
  });
});

describe('parseNodeClause — error paths', () => {
  it('rejects non-object node clause', () => {
    expect(() => parseWhen({ node: 'command' }, 'ctx'))
      .toThrow(/node must be a YAML mapping/);
  });

  it('rejects unknown field in node clause', () => {
    expect(() => parseWhen({ node: { flavor: 'vanilla' } }, 'ctx'))
      .toThrow(/unknown field 'flavor'/);
  });

  it('rejects empty node clause object', () => {
    expect(() => parseWhen({ node: {} }, 'ctx'))
      .toThrow(/at least one of type, has_port, has_mapping, id must be present/);
  });

  it('rejects non-string type in node clause', () => {
    expect(() => parseWhen({ node: { type: 123 } }, 'ctx'))
      .toThrow(/type must be a non-empty string/);
  });

  it('rejects empty type in node clause', () => {
    expect(() => parseWhen({ node: { type: '' } }, 'ctx'))
      .toThrow(/type must be a non-empty string/);
  });

  it('rejects non-string has_port in node clause', () => {
    expect(() => parseWhen({ node: { has_port: [] } }, 'ctx'))
      .toThrow(/has_port must be a non-empty string/);
  });

  it('rejects empty has_port in node clause', () => {
    expect(() => parseWhen({ node: { has_port: '  ' } }, 'ctx'))
      .toThrow(/has_port must be a non-empty string/);
  });

  it('rejects non-boolean has_mapping in node clause', () => {
    expect(() => parseWhen({ node: { has_mapping: 'yes' } }, 'ctx'))
      .toThrow(/has_mapping must be a boolean/);
  });

  it('lists id among allowed fields for an unknown field', () => {
    expect(() => parseWhen({ node: { qqq: 1 } }, 'ctx'))
      .toThrow(/allowed: type, has_port, has_mapping, id/);
  });

  it('rejects empty string id', () => {
    expect(() => parseWhen({ node: { id: '' } }, 'ctx'))
      .toThrow(/id must be a non-empty string/);
  });

  it('rejects empty array id', () => {
    expect(() => parseWhen({ node: { id: [] } }, 'ctx'))
      .toThrow(/id array must not be empty/);
  });

  it('rejects an empty entry inside an id array, naming its index', () => {
    expect(() => parseWhen({ node: { id: ['a', ''] } }, 'ctx'))
      .toThrow(/id\[1\] must be a non-empty string/);
  });

  it('rejects a duplicate entry inside an id array', () => {
    expect(() => parseWhen({ node: { id: ['a', 'a'] } }, 'ctx'))
      .toThrow(/id contains duplicate 'a'/);
  });

  it('rejects a numeric id', () => {
    expect(() => parseWhen({ node: { id: 7 } }, 'ctx'))
      .toThrow(/id must be a non-empty string/);
  });

  it('rejects an object id', () => {
    expect(() => parseWhen({ node: { id: {} } }, 'ctx'))
      .toThrow(/id must be a non-empty string/);
  });
});

describe('parseWhen', () => {
  it('parses top-level atomic clause (implicit all_of)', () => {
    const raw = { relations: { calls: { target_type: 'service-client' } } };
    const result = parseWhen(raw, 'ctx');
    expect(result).toEqual({
      relations: { calls: { target_type: 'service-client' } },
    });
  });

  it('parses any_of', () => {
    const raw = {
      any_of: [
        { relations: { calls: { target_type: 'a' } } },
        { node: { has_port: 'charge' } },
      ],
    };
    const result = parseWhen(raw, 'ctx');
    expect(result).toEqual(raw);
  });

  it('parses all_of', () => {
    const raw = { all_of: [{ node: { type: 'command' } }] };
    const result = parseWhen(raw, 'ctx');
    expect(result).toEqual(raw);
  });

  it('parses not', () => {
    const raw = { not: { node: { has_mapping: false } } };
    const result = parseWhen(raw, 'ctx');
    expect(result).toEqual(raw);
  });

  it('parses descendants clause', () => {
    const raw = {
      descendants: {
        relations: { calls: { target_type: 'service-client' } },
        type: 'handler',
        has_port: 'subscribe',
      },
    };
    const result = parseWhen(raw, 'ctx');
    expect(result).toEqual(raw);
  });

  it('throws on unknown top-level operator', () => {
    expect(() => parseWhen({ mostly_of: [] }, 'ctx'))
      .toThrow(/unknown when operator 'mostly_of'/);
  });

  it('throws on unknown relation type inside relations', () => {
    expect(() => parseWhen({ relations: { invokes: {} } }, 'ctx'))
      .toThrow(/unknown relation type 'invokes'/);
  });

  it('throws when when is not an object', () => {
    expect(() => parseWhen('yes', 'ctx'))
      .toThrow(/must be a YAML mapping/);
  });

  it('throws when all_of is not an array', () => {
    expect(() => parseWhen({ all_of: 'x' }, 'ctx'))
      .toThrow(/'all_of' must be an array/);
  });

  it('throws on unknown atomic clause key', () => {
    expect(() => parseWhen({ banana: {} }, 'ctx'))
      .toThrow(/unknown when operator 'banana'/);
  });

  it('parses node.id as a single string', () => {
    const result = parseWhen({ node: { id: 'a/b' } }, 'ctx');
    expect(result).toEqual({ node: { id: 'a/b' } });
  });

  it('parses node.id as a list of strings', () => {
    const result = parseWhen({ node: { id: ['a/b', 'c/d'] } }, 'ctx');
    expect(result).toEqual({ node: { id: ['a/b', 'c/d'] } });
  });

  it('trims a node.id string', () => {
    const result = parseWhen({ node: { id: '  a/b  ' } }, 'ctx');
    expect(result).toEqual({ node: { id: 'a/b' } });
  });

  it('parses node.id together with type as an implicit AND within the clause', () => {
    const result = parseWhen({ node: { id: 'a', type: 'x' } }, 'ctx');
    expect(result).toEqual({ node: { id: 'a', type: 'x' } });
  });

  it('parses not: around node.id (negation regression)', () => {
    const raw = { not: { node: { id: 'a/b' } } };
    const result = parseWhen(raw, 'ctx');
    expect(result).toEqual(raw);
  });

  it('parses not: nested inside all_of alongside a plain node clause', () => {
    const raw = {
      all_of: [
        { not: { node: { id: 'a' } } },
        { node: { type: 't' } },
      ],
    };
    const result = parseWhen(raw, 'ctx');
    expect(result).toEqual(raw);
  });
});

describe('parseAspectAttachment', () => {
  it('parses a bare-string aspect id', () => {
    const result = parseAspectAttachment('my-aspect', 'ctx');
    expect(result).toEqual({ id: 'my-aspect' });
  });

  it('trims whitespace around a bare-string id', () => {
    expect(parseAspectAttachment('  trimmed  ', 'ctx')).toEqual({ id: 'trimmed' });
  });

  it('rejects an empty bare string', () => {
    expect(() => parseAspectAttachment('', 'ctx'))
      .toThrow(/aspect id must be a non-empty string/);
  });

  it('rejects a whitespace-only bare string', () => {
    expect(() => parseAspectAttachment('   ', 'ctx'))
      .toThrow(/aspect id must be a non-empty string/);
  });

  it('parses object form with id only', () => {
    expect(parseAspectAttachment({ id: 'my-aspect' }, 'ctx')).toEqual({ id: 'my-aspect' });
  });

  it('parses object form with id and when', () => {
    const result = parseAspectAttachment(
      { id: 'a', when: { node: { type: 'command' } } },
      'ctx',
    );
    expect(result).toEqual({
      id: 'a',
      when: { node: { type: 'command' } },
    });
  });

  it('rejects object form missing id', () => {
    expect(() => parseAspectAttachment({ when: { node: { type: 'x' } } }, 'ctx'))
      .toThrow(/object form requires 'id' as a non-empty string/);
  });

  it('rejects object form with empty id', () => {
    expect(() => parseAspectAttachment({ id: '' }, 'ctx'))
      .toThrow(/object form requires 'id' as a non-empty string/);
  });

  it('rejects object form with unknown field', () => {
    expect(() => parseAspectAttachment({ id: 'a', exceptions: [] }, 'ctx'))
      .toThrow(/unknown field 'exceptions' in aspect attachment/);
  });

  it('rejects arrays', () => {
    expect(() => parseAspectAttachment(['a'], 'ctx'))
      .toThrow(/aspect attachment must be a string or an object/);
  });

  it('rejects numbers', () => {
    expect(() => parseAspectAttachment(42, 'ctx'))
      .toThrow(/aspect attachment must be a string or an object/);
  });

  it('rejects null', () => {
    expect(() => parseAspectAttachment(null, 'ctx'))
      .toThrow(/aspect attachment must be a string or an object/);
  });
});
