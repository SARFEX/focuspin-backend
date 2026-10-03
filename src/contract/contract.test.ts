import { describe, expect, test } from 'bun:test';
import { extractJsonCandidate, validateMagicContent } from './index.ts';
import { kMagicMaxCommands, parseTaskCommandBatch } from './commands.ts';
import type { ContractResult, ParseIssue } from './index.ts';

const codes = (result: ContractResult): string[] => (result.ok ? [] : result.issues.map((issue) => issue.code));
const firstIssue = (result: ContractResult): ParseIssue => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected failure');
  const issue = result.issues[0];
  if (issue === undefined) throw new Error('expected at least one issue');
  return issue;
};

describe('extractJsonCandidate', () => {
  test('returns trimmed text when it is already JSON', () => {
    expect(extractJsonCandidate('  {"commands":[]}  ')).toBe('{"commands":[]}');
  });

  test('strips a ```json fence', () => {
    expect(extractJsonCandidate('```json\n{"commands":[]}\n```')).toBe('{"commands":[]}');
  });

  test('strips a bare ``` fence', () => {
    expect(extractJsonCandidate('```\n{"commands":[]}\n```')).toBe('{"commands":[]}');
  });

  test('prefers fence content over raw text', () => {
    expect(extractJsonCandidate('Отвечаю: ```json\n{"commands":[]}\n``` конец')).toBe('{"commands":[]}');
  });

  test('takes the balanced object from surrounding prose', () => {
    expect(extractJsonCandidate('Ответ: {"commands":[{"intent":"create","title":"A"}]} рад помочь')).toBe(
      '{"commands":[{"intent":"create","title":"A"}]}',
    );
  });

  test('takes the first of several balanced fragments', () => {
    expect(extractJsonCandidate('{"a":1} middle {"b":2}')).toBe('{"a":1}');
  });

  test('brackets inside string literals do not break balancing', () => {
    expect(extractJsonCandidate('{"a":"внутри [скобки] и {фигурные}"}')).toBe('{"a":"внутри [скобки] и {фигурные}"}');
  });

  test('brace inside a string: balanced scan finds nothing, slice fallback truncates (Dart parity)', () => {
    expect(extractJsonCandidate('{"a":"}{ not a brace }"')).toBe('{"a":"}{ not a brace }');
  });

  test('escaped quotes inside strings are handled', () => {
    expect(extractJsonCandidate('{"a":"x \\" y"}')).toBe('{"a":"x \\" y"}');
  });

  test('takes a balanced array fragment', () => {
    expect(extractJsonCandidate('преамбула [{"intent":"create"}] эпилог')).toBe('[{"intent":"create"}]');
  });

  test('unclosed bracket — no candidate', () => {
    expect(extractJsonCandidate('{"commands": [')).toBeNull();
  });

  test('empty and whitespace-only text — no candidate', () => {
    expect(extractJsonCandidate('')).toBeNull();
    expect(extractJsonCandidate('  \n\t ')).toBeNull();
  });

  test('prose without brackets — no candidate', () => {
    expect(extractJsonCandidate('Просто слова, ничего больше.')).toBeNull();
  });
});

describe('validateMagicContent — success', () => {
  test('create single: bucket default emitted, canonical key order', () => {
    const result = validateMagicContent('{"commands":[{"intent":"create","title":"Купить молока"}]}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands).toEqual([{ intent: 'create', title: 'Купить молока', bucket: 'today' }]);
    expect(result.canonicalJson).toBe('{"commands":[{"intent":"create","title":"Купить молока","bucket":"today"}]}');
  });

  test('bucket variants preserved', () => {
    const result = validateMagicContent(
      '{"commands":[{"intent":"create","title":"A","bucket":"tomorrow"},{"intent":"create","title":"B","bucket":"backlog"},{"intent":"create","title":"C","bucket":"today"}]}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands.map((c) => (c.intent === 'create' ? c.bucket : null))).toEqual(['tomorrow', 'backlog', 'today']);
  });

  test('optional fields omitted when absent, kept when present', () => {
    const result = validateMagicContent(
      '{"commands":[{"intent":"create","title":"A","description":"Детали","ref":"a"},{"intent":"create","title":"B"}]}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands).toEqual([
      { intent: 'create', title: 'A', bucket: 'today', description: 'Детали', ref: 'a' },
      { intent: 'create', title: 'B', bucket: 'today' },
    ]);
  });

  test('canonical key order: intent, target, title, description for edit', () => {
    const result = validateMagicContent('{"commands":[{"intent":"edit","title":"T","id":"t1","description":"D"}]}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canonicalJson).toBe('{"commands":[{"intent":"edit","id":"t1","title":"T","description":"D"}]}');
  });

  test('bare array is accepted', () => {
    const result = validateMagicContent('[{"intent":"complete","id":"t1"}]');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands).toEqual([{ intent: 'complete', id: 't1' }]);
  });

  test('empty commands list is valid', () => {
    const result = validateMagicContent('{"commands":[]}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands).toEqual([]);
    expect(result.canonicalJson).toBe('{"commands":[]}');
  });

  test('values and intents are trimmed', () => {
    const result = validateMagicContent('{"commands":[{"intent":"  complete  ","id":"  t-1  "},{"intent":"create","title":"\\n  Хлеб  "}]}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands).toEqual([
      { intent: 'complete', id: 't-1' },
      { intent: 'create', title: 'Хлеб', bucket: 'today' },
    ]);
  });

  test('all targeted intents round-trip with each target kind', () => {
    const result = validateMagicContent(
      '{"commands":[' +
        '{"intent":"create","title":"Новая","ref":"r1"},' +
        '{"intent":"delete","id":"t1"},' +
        '{"intent":"complete","titleQuery":"отчёт"},' +
        '{"intent":"uncomplete","ref":"r1"},' +
        '{"intent":"move_to_tomorrow","id":"t2"},' +
        '{"intent":"move_to_today","titleQuery":"хлеб"},' +
        '{"intent":"move_to_backlog","ref":"r1"}' +
        ']}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands).toEqual([
      { intent: 'create', title: 'Новая', bucket: 'today', ref: 'r1' },
      { intent: 'delete', id: 't1' },
      { intent: 'complete', titleQuery: 'отчёт' },
      { intent: 'uncomplete', ref: 'r1' },
      { intent: 'move_to_tomorrow', id: 't2' },
      { intent: 'move_to_today', titleQuery: 'хлеб' },
      { intent: 'move_to_backlog', ref: 'r1' },
    ]);
  });

  test('ref chain: create registers ref for later commands', () => {
    const result = validateMagicContent(
      '{"commands":[{"intent":"create","title":"Позвонить","ref":"call"},{"intent":"edit","ref":"call","title":"Позвонить вечером"},{"intent":"delete","ref":"call"}]}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands).toEqual([
      { intent: 'create', title: 'Позвонить', bucket: 'today', ref: 'call' },
      { intent: 'edit', ref: 'call', title: 'Позвонить вечером' },
      { intent: 'delete', ref: 'call' },
    ]);
  });

  test('exactly kMagicMaxCommands commands pass', () => {
    const commands = Array.from({ length: kMagicMaxCommands }, (_, i) => ({ intent: 'create', title: `T${i}` }));
    const result = parseTaskCommandBatch({ commands });
    expect(result.ok).toBe(true);
  });

  test('canonicalJson is plain parseable JSON', () => {
    const result = validateMagicContent('{"commands":[{"intent":"create","title":"Кавычки \\"внутри\\""}]}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.canonicalJson)).toEqual({ commands: [{ intent: 'create', title: 'Кавычки "внутри"', bucket: 'today' }] });
  });
});

describe('validateMagicContent — top-level issues', () => {
  test('emptyContent', () => {
    expect(codes(validateMagicContent(''))).toEqual(['emptyContent']);
    expect(codes(validateMagicContent('  \n\t '))).toEqual(['emptyContent']);
  });

  test('invalidJson for prose without any JSON', () => {
    expect(codes(validateMagicContent('Извините, я вас не понял.'))).toEqual(['invalidJson']);
  });

  test('invalidJson for truncated JSON', () => {
    expect(codes(validateMagicContent('{"commands": [{"intent":"create"'))).toEqual(['invalidJson']);
  });

  test('notAnObject for top-level primitives', () => {
    expect(codes(validateMagicContent('42'))).toEqual(['notAnObject']);
    expect(codes(validateMagicContent('"строка"'))).toEqual(['notAnObject']);
    expect(codes(validateMagicContent('null'))).toEqual(['notAnObject']);
  });

  test('notAnObject for non-object command elements, with commandIndex', () => {
    const result = validateMagicContent('{"commands":[7]}');
    expect(codes(result)).toEqual(['notAnObject']);
    const issue = firstIssue(result);
    expect(issue.commandIndex).toBe(0);
  });

  test('unknownTopLevelKey, top-level issue has no commandIndex', () => {
    const result = validateMagicContent('{"commands":[],"requestId":"abc"}');
    expect(codes(result)).toEqual(['unknownTopLevelKey']);
    const issue = firstIssue(result);
    expect(issue.commandIndex).toBeUndefined();
    expect(issue.message).toContain('requestId');
  });

  test('commandsNotList for non-list commands value', () => {
    for (const raw of ['{"commands":5}', '{"commands":"нет"}', '{"commands":null}', '{}']) {
      expect(codes(validateMagicContent(raw))).toEqual(['commandsNotList']);
    }
  });

  test('unknownTopLevelKey is reported before commandsNotList', () => {
    expect(codes(validateMagicContent('{"meta":1,"commands":5}'))).toEqual(['unknownTopLevelKey', 'commandsNotList']);
  });

  test('tooManyCommands: strict boundary at 30/31, early return', () => {
    const thirty = { commands: Array.from({ length: 30 }, (_, i) => ({ intent: 'create', title: `T${i}` })) };
    expect(parseTaskCommandBatch(thirty).ok).toBe(true);
    const thirtyOne = { commands: Array.from({ length: 31 }, () => 'мусор') };
    expect(codes(parseTaskCommandBatch(thirtyOne))).toEqual(['tooManyCommands']);
  });
});

describe('validateMagicContent — command issues', () => {
  test('unknownIntent', () => {
    const result = validateMagicContent('{"commands":[{"intent":"archive","id":"t1"}]}');
    expect(codes(result)).toEqual(['unknownIntent']);
    const issue = firstIssue(result);
    expect(issue.field).toBe('intent');
    expect(issue.commandIndex).toBe(0);
  });

  test('missingIntent', () => {
    expect(codes(validateMagicContent('{"commands":[{"title":"Задача"}]}'))).toEqual(['missingIntent']);
  });

  test('intent notAString / emptyValue', () => {
    expect(codes(validateMagicContent('{"commands":[{"intent":5}]}'))).toEqual(['notAString']);
    expect(codes(validateMagicContent('{"commands":[{"intent":"   "}]}'))).toEqual(['emptyValue']);
  });

  test('missingTitle when create has no title', () => {
    const result = validateMagicContent('{"commands":[{"intent":"create","bucket":"today"}]}');
    expect(codes(result)).toEqual(['missingTitle']);
    expect(firstIssue(result).field).toBe('title');
  });

  test('invalid title does not double-report missingTitle', () => {
    expect(codes(validateMagicContent('{"commands":[{"intent":"create","title":123}]}'))).toEqual(['notAString']);
    expect(codes(validateMagicContent('{"commands":[{"intent":"create","title":"   "}]}'))).toEqual(['emptyValue']);
  });

  test('unknownBucket (case-sensitive whitelist)', () => {
    expect(codes(validateMagicContent('{"commands":[{"intent":"create","title":"T","bucket":"someday"}]}'))).toEqual(['unknownBucket']);
    expect(codes(validateMagicContent('{"commands":[{"intent":"create","title":"T","bucket":"Today"}]}'))).toEqual(['unknownBucket']);
  });

  test('bucket notAString / emptyValue', () => {
    expect(codes(validateMagicContent('{"commands":[{"intent":"create","title":"T","bucket":null}]}'))).toEqual(['notAString']);
    expect(codes(validateMagicContent('{"commands":[{"intent":"create","title":"T","bucket":""}]}'))).toEqual(['emptyValue']);
  });

  test('duplicateRef on the second create', () => {
    const result = validateMagicContent('{"commands":[{"intent":"create","title":"A","ref":"x"},{"intent":"create","title":"B","ref":"x"}]}');
    expect(codes(result)).toEqual(['duplicateRef']);
    const issue = firstIssue(result);
    expect(issue.commandIndex).toBe(1);
    expect(issue.field).toBe('ref');
  });

  test('ref matching is case-sensitive', () => {
    expect(codes(validateMagicContent('{"commands":[{"intent":"create","title":"A","ref":"x"},{"intent":"complete","ref":"X"}]}'))).toEqual([
      'unknownRef',
    ]);
  });

  test('unknownRef for ref declared by a LATER create only', () => {
    expect(
      codes(validateMagicContent('{"commands":[{"intent":"complete","ref":"later"},{"intent":"create","title":"A","ref":"later"}]}')),
    ).toEqual(['unknownRef']);
  });

  test('refs of failed creates still register (Dart quirk kept 1:1)', () => {
    // create #0 registers ref "a", then fails on unknownBucket; complete #1 still resolves "a".
    const result = validateMagicContent(
      '{"commands":[{"intent":"create","title":"T","ref":"a","bucket":"bad"},{"intent":"complete","ref":"a"}]}',
    );
    expect(codes(result)).toEqual(['unknownBucket']);
  });

  test('missingTarget', () => {
    expect(codes(validateMagicContent('{"commands":[{"intent":"delete"}]}'))).toEqual(['missingTarget']);
    expect(codes(validateMagicContent('{"commands":[{"intent":"move_to_tomorrow"}]}'))).toEqual(['missingTarget']);
  });

  test('ambiguousTarget lists the conflicting keys', () => {
    const result = validateMagicContent('{"commands":[{"intent":"delete","id":"t1","titleQuery":"Отчёт","ref":"r"}]}');
    expect(codes(result)).toEqual(['ambiguousTarget']);
    expect(firstIssue(result).message).toContain('id, titleQuery, ref');
  });

  test('unknownRef', () => {
    const result = validateMagicContent('{"commands":[{"intent":"complete","ref":"ghost"}]}');
    expect(codes(result)).toEqual(['unknownRef']);
    expect(firstIssue(result).field).toBe('ref');
  });

  test('missingEditPayload when neither title nor description', () => {
    expect(codes(validateMagicContent('{"commands":[{"intent":"edit","id":"t1"}]}'))).toEqual(['missingEditPayload']);
  });

  test('edit without target but with payload: only missingTarget', () => {
    expect(codes(validateMagicContent('{"commands":[{"intent":"edit","title":"Новое"}]}'))).toEqual(['missingTarget']);
  });

  test('edit without target and without payload: both issues in order', () => {
    expect(codes(validateMagicContent('{"commands":[{"intent":"edit"}]}'))).toEqual(['missingTarget', 'missingEditPayload']);
  });

  test('unknownField per-intent whitelist', () => {
    expect(codes(validateMagicContent('{"commands":[{"intent":"create","title":"T","priority":"high"}]}'))).toEqual(['unknownField']);
    // bucket is not allowed for delete — only intent + one target.
    expect(codes(validateMagicContent('{"commands":[{"intent":"delete","id":"t1","bucket":"today"}]}'))).toEqual(['unknownField']);
  });

  test('unknownField does not stop further checks', () => {
    expect(codes(validateMagicContent('{"commands":[{"intent":"create","priority":1}]}'))).toEqual(['unknownField', 'missingTitle']);
    expect(codes(validateMagicContent('{"commands":[{"intent":"delete","priority":1}]}'))).toEqual(['unknownField', 'missingTarget']);
  });

  test('target field notAString', () => {
    expect(codes(validateMagicContent('{"commands":[{"intent":"complete","id":5}]}'))).toEqual(['notAString']);
  });

  test('length boundaries: title 500/501, description 2000/2001, titleQuery 200/201, id 64/65, ref 64/65', () => {
    const check = (field: string, value: string, ok: boolean): void => {
      const command =
        field === 'title' || field === 'description'
          ? { intent: 'create', title: 'T', [field]: value }
          : { intent: 'complete', [field]: value };
      const result = parseTaskCommandBatch({ commands: [command] });
      expect(result.ok).toBe(ok);
    };
    check('title', 'а'.repeat(500), true);
    check('title', 'а'.repeat(501), false);
    check('description', 'а'.repeat(2000), true);
    check('description', 'а'.repeat(2001), false);
    check('titleQuery', 'а'.repeat(200), true);
    check('titleQuery', 'а'.repeat(201), false);
    check('id', 'а'.repeat(64), true);
    check('id', 'а'.repeat(65), false);
    const createRef = (value: string): void => {
      const result = parseTaskCommandBatch({ commands: [{ intent: 'create', title: 'T', ref: value }] });
      expect(result.ok).toBe(value.length <= 64);
    };
    createRef('а'.repeat(64));
    createRef('а'.repeat(65));
  });

  test('tooLong codes carry the field name', () => {
    const result = validateMagicContent(`{"commands":[{"intent":"create","title":"${'а'.repeat(501)}"}]}`);
    expect(codes(result)).toEqual(['tooLong']);
    expect(firstIssue(result).field).toBe('title');
  });
});

describe('validateMagicContent — batch semantics', () => {
  test('all-or-nothing: a single bad command rejects the whole batch', () => {
    const result = validateMagicContent(
      '{"commands":[{"intent":"create","title":"Хорошая"},{"intent":"delete"},{"intent":"create","title":"Ещё одна"}]}',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(['missingTarget']);
    expect(result.issues[0]?.commandIndex).toBe(1);
    expect('commands' in result).toBe(false);
  });

  test('issues from several commands collected in order', () => {
    const result = validateMagicContent(
      '{"commands":[{"intent":"create"},{"intent":"create","title":"Валидная"},{"intent":"delete"},{"intent":"create","title":"Ещё","bucket":"weekend"}]}',
    );
    expect(codes(result)).toEqual(['missingTitle', 'missingTarget', 'unknownBucket']);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.commandIndex)).toEqual([0, 2, 3]);
  });

  test('valid balanced candidate wins over an earlier broken one', () => {
    const result = validateMagicContent('{"commands":[{"intent":"archive"}]} финальный ответ: {"commands":[]}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands).toEqual([]);
  });

  test('when all candidates decode but fail, the first failure is reported', () => {
    expect(codes(validateMagicContent('{"commands":[{"intent":"nope","id":"t1"}]} затем {"commands":5}'))).toEqual(['unknownIntent']);
    expect(codes(validateMagicContent('{"commands":5} и ещё {"commands":6}'))).toEqual(['commandsNotList']);
  });

  test('fence candidate rescues raw text that does not decode', () => {
    const result = validateMagicContent('Ответ:\n```json\n{"commands":[{"intent":"create","title":"Посылка"}]}\n```\nпояснение');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands).toEqual([{ intent: 'create', title: 'Посылка', bucket: 'today' }]);
  });

  test('escaped quotes inside strings do not break extraction', () => {
    const result = validateMagicContent('{"commands":[{"intent":"create","title":"Сказал \\"привет { скобка\\""}]}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands[0]).toEqual({ intent: 'create', title: 'Сказал "привет { скобка"', bucket: 'today' });
  });
});
