/**
 * Schema of magic commands v4 — a 1:1 mirror of the focuspin app's
 * lib/magic_input/task_command.dart (private repo): same intents, fields,
 * limits, issue codes, check order and all-or-nothing batch semantics.
 * THE SOURCE OF TRUTH IS THE DART FILE. Any change here must land in both
 * repos simultaneously (see contract/schema-v4.md).
 */

// ---- Limits (kMagic* constants in task_command.dart) ----
export const kMagicMaxTitleLength = 500;
export const kMagicMaxDescriptionLength = 2000;
export const kMagicMaxTitleQueryLength = 200;
export const kMagicMaxRefLength = 64;
export const kMagicMaxCommands = 30;

// ---- Public types (frozen API, re-exported from index.ts) ----

export type MagicIntent =
  | 'create'
  | 'edit'
  | 'delete'
  | 'complete'
  | 'uncomplete'
  | 'move_to_tomorrow'
  | 'move_to_today'
  | 'move_to_backlog';

export type MagicBucket = 'today' | 'tomorrow' | 'backlog';

export interface ParseIssue {
  /** Code mirrors the issue codes of lib/magic_input/task_command.dart. */
  code: string;
  message: string;
  /** Index of the command in `commands`; omitted for top-level issues (Dart uses -1). */
  commandIndex?: number;
  /** Offending field name, when the issue is tied to one. */
  field?: string;
}

export type ContractResult =
  | { ok: true; commands: MagicCommand[]; canonicalJson: string }
  | { ok: false; issues: ParseIssue[] };

export interface TargetById {
  id: string;
}
export interface TargetByTitleQuery {
  titleQuery: string;
}
export interface TargetByRef {
  ref: string;
}
export type CommandTarget = TargetById | TargetByTitleQuery | TargetByRef;

export interface MagicCommandCreate {
  intent: 'create';
  title: string;
  bucket?: MagicBucket;
  description?: string;
  ref?: string;
}
export interface MagicCommandEdit {
  intent: 'edit';
  title?: string;
  description?: string;
}
export interface MagicCommandWithTargetBase {
  intent: 'delete' | 'complete' | 'uncomplete' | 'move_to_tomorrow' | 'move_to_today' | 'move_to_backlog';
}
export type MagicCommand =
  | MagicCommandCreate
  | (MagicCommandEdit & CommandTarget)
  | (MagicCommandWithTargetBase & CommandTarget);

// ---- Internal helpers ----

type TargetedIntent = MagicCommandWithTargetBase['intent'];
type TargetField = 'id' | 'titleQuery' | 'ref';

/** Resolved target: which single key and its trimmed value. */
interface ParsedTarget {
  field: TargetField;
  value: string;
}

const TARGET_KEYS: readonly TargetField[] = ['id', 'titleQuery', 'ref'];

const KNOWN_INTENTS: ReadonlySet<string> = new Set<MagicIntent>([
  'create',
  'edit',
  'delete',
  'complete',
  'uncomplete',
  'move_to_tomorrow',
  'move_to_today',
  'move_to_backlog',
]);

const TARGETED_ALLOWED_KEYS: ReadonlySet<string> = new Set(['intent', 'id', 'titleQuery', 'ref']);

/** Allowed fields per intent — strict: an extra field means the model left the schema. */
const ALLOWED_KEYS_BY_INTENT: Record<MagicIntent, ReadonlySet<string>> = {
  create: new Set(['intent', 'title', 'bucket', 'description', 'ref']),
  edit: new Set(['intent', 'title', 'description', 'id', 'titleQuery', 'ref']),
  delete: TARGETED_ALLOWED_KEYS,
  complete: TARGETED_ALLOWED_KEYS,
  uncomplete: TARGETED_ALLOWED_KEYS,
  move_to_tomorrow: TARGETED_ALLOWED_KEYS,
  move_to_today: TARGETED_ALLOWED_KEYS,
  move_to_backlog: TARGETED_ALLOWED_KEYS,
};

type FieldStatus = { status: 'missing' } | { status: 'invalid' } | { status: 'ok'; value: string };

// ---- Canonical re-serialization (key order mirrors taskCommandToJson in Dart) ----

function canonicalTargetCommand(intent: TargetedIntent, target: ParsedTarget): MagicCommand {
  if (target.field === 'id') return { intent, id: target.value };
  if (target.field === 'titleQuery') return { intent, titleQuery: target.value };
  return { intent, ref: target.value };
}

function canonicalEditCommand(target: ParsedTarget, title: string | undefined, description: string | undefined): MagicCommand {
  let command: MagicCommandEdit & CommandTarget;
  if (target.field === 'id') command = { intent: 'edit', id: target.value };
  else if (target.field === 'titleQuery') command = { intent: 'edit', titleQuery: target.value };
  else command = { intent: 'edit', ref: target.value };
  if (title !== undefined) command.title = title;
  if (description !== undefined) command.description = description;
  return command;
}

function canonicalCreateCommand(title: string, bucket: MagicBucket, description: string | undefined, ref: string | undefined): MagicCommand {
  // bucket is always emitted (default 'today'), like taskCommandToJson in Dart.
  const command: MagicCommandCreate = { intent: 'create', title, bucket };
  if (description !== undefined) command.description = description;
  if (ref !== undefined) command.ref = ref;
  return command;
}

// ---- Batch parsing (mirror of parseTaskCommandBatch in task_command.dart) ----

/**
 * Parses decoded JSON (top-level Map with a `commands` key, or a bare List)
 * into a command batch. Never throws. All-or-nothing: any issue rejects the
 * whole batch, no partial commands are returned.
 */
export function parseTaskCommandBatch(decoded: unknown): ContractResult {
  const issues: ParseIssue[] = [];
  let commandsRaw: unknown;
  if (Array.isArray(decoded)) {
    // Bare array — tolerated alternative to {"commands": [...]}.
    commandsRaw = decoded;
  } else if (typeof decoded === 'object' && decoded !== null) {
    const record = decoded as Record<string, unknown>;
    const extraKeys = Object.keys(record).filter((key) => key !== 'commands');
    if (extraKeys.length > 0) {
      issues.push({
        code: 'unknownTopLevelKey',
        message: `Неизвестные поля верхнего уровня: ${extraKeys.join(', ')}. Ожидался объект с единственным полем "commands".`,
      });
    }
    commandsRaw = record['commands'];
  } else {
    return {
      ok: false,
      issues: [{ code: 'notAnObject', message: 'Ответ должен быть JSON-объектом вида {"commands": [...]}.' }],
    };
  }

  if (!Array.isArray(commandsRaw)) {
    issues.push({ code: 'commandsNotList', message: 'Поле "commands" должно быть массивом команд.' });
    return { ok: false, issues };
  }

  if (commandsRaw.length > kMagicMaxCommands) {
    issues.push({
      code: 'tooManyCommands',
      message: `Слишком много команд: ${commandsRaw.length} (максимум ${kMagicMaxCommands}).`,
    });
    return { ok: false, issues };
  }

  const commands: MagicCommand[] = [];
  const knownRefs = new Set<string>();
  for (let i = 0; i < commandsRaw.length; i++) {
    const command = parseCommand(commandsRaw[i], i, knownRefs, issues);
    if (command !== null) commands.push(command);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, commands, canonicalJson: JSON.stringify({ commands }) };
}

/**
 * Parses a single command; appends diagnostics and returns null on error.
 * knownRefs accumulates labels of create commands (duplicates are an error)
 * and keeps them even when the create command itself fails later — same as
 * the Dart implementation.
 */
function parseCommand(raw: unknown, index: number, knownRefs: Set<string>, issues: ParseIssue[]): MagicCommand | null {
  const fail = (code: string, message: string, field?: string): void => {
    issues.push(field === undefined ? { code, message, commandIndex: index } : { code, message, commandIndex: index, field });
  };

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('notAnObject', 'Элемент массива команд должен быть JSON-объектом.');
    return null;
  }
  const record = raw as Record<string, unknown>;

  // Reads a string field: values are trimmed; empty after trim is invalid.
  const readString = (key: string): FieldStatus => {
    if (!Object.hasOwn(record, key)) return { status: 'missing' };
    const value = record[key];
    if (typeof value !== 'string') {
      fail('notAString', `Поле "${key}" должно быть строкой.`, key);
      return { status: 'invalid' };
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      fail('emptyValue', `Поле "${key}" не может быть пустым.`, key);
      return { status: 'invalid' };
    }
    return { status: 'ok', value: trimmed };
  };

  // String field with a length cap; null means a diagnostic was already added.
  const boundedString = (key: string, maxLength: number): string | null => {
    const status = readString(key);
    if (status.status !== 'ok') return null;
    if (status.value.length > maxLength) {
      fail('tooLong', `Поле "${key}" длиннее ${maxLength} символов.`, key);
      return null;
    }
    return status.value;
  };

  const intentStatus = readString('intent');
  if (intentStatus.status !== 'ok') {
    if (intentStatus.status === 'missing') {
      fail('missingIntent', 'Обязательное поле "intent" отсутствует.');
    }
    return null;
  }
  const intent = intentStatus.value;
  if (!KNOWN_INTENTS.has(intent)) {
    fail('unknownIntent', `Неизвестный intent: "${intent}".`, 'intent');
    return null;
  }

  // Unknown-field scan runs before target/payload checks and does not stop parsing.
  const allowedKeys = ALLOWED_KEYS_BY_INTENT[intent as MagicIntent];
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      fail('unknownField', `Поле "${key}" недопустимо для intent "${intent}".`, key);
    }
  }

  // Target — for every intent except create.
  let target: ParsedTarget | null = null;
  if (intent !== 'create') {
    const present = TARGET_KEYS.filter((key) => Object.hasOwn(record, key));
    if (present.length === 0) {
      fail('missingTarget', `Команда "${intent}" требует цель: "id", "titleQuery" или "ref".`);
    } else if (present.length > 1) {
      fail('ambiguousTarget', `Указано несколько полей цели (${present.join(', ')}) — нужно ровно одно.`);
    } else {
      const key = present[0];
      if (key === 'id') {
        const id = boundedString('id', kMagicMaxRefLength);
        if (id !== null) target = { field: 'id', value: id };
      } else if (key === 'titleQuery') {
        const query = boundedString('titleQuery', kMagicMaxTitleQueryLength);
        if (query !== null) target = { field: 'titleQuery', value: query };
      } else {
        const ref = boundedString('ref', kMagicMaxRefLength);
        if (ref !== null) {
          if (!knownRefs.has(ref)) {
            fail('unknownRef', `Метка "ref": "${ref}" не объявлена ни одной командой create выше.`, 'ref');
          } else {
            target = { field: 'ref', value: ref };
          }
        }
      }
    }
  }

  if (intent === 'create') {
    const title = boundedString('title', kMagicMaxTitleLength);
    if (title === null) {
      if (!Object.hasOwn(record, 'title')) {
        fail('missingTitle', 'Команда create требует поле "title".', 'title');
      }
      return null;
    }
    let ref: string | undefined;
    if (Object.hasOwn(record, 'ref')) {
      const parsedRef = boundedString('ref', kMagicMaxRefLength);
      if (parsedRef === null) return null;
      if (knownRefs.has(parsedRef)) {
        fail('duplicateRef', `Метка "ref": "${parsedRef}" уже использована.`, 'ref');
        return null;
      }
      // Registered before bucket/description checks, mirroring the Dart order.
      knownRefs.add(parsedRef);
      ref = parsedRef;
    }
    let bucket: MagicBucket = 'today';
    if (Object.hasOwn(record, 'bucket')) {
      const bucketStatus = readString('bucket');
      if (bucketStatus.status !== 'ok') return null;
      const value = bucketStatus.value;
      if (value === 'tomorrow') {
        bucket = 'tomorrow';
      } else if (value === 'backlog') {
        bucket = 'backlog';
      } else if (value !== 'today') {
        fail('unknownBucket', `Поле "bucket" допускает только "today", "tomorrow" или "backlog", получено "${value}".`, 'bucket');
        return null;
      }
    }
    let description: string | undefined;
    if (Object.hasOwn(record, 'description')) {
      const parsedDescription = boundedString('description', kMagicMaxDescriptionLength);
      if (parsedDescription === null) return null;
      description = parsedDescription;
    }
    return canonicalCreateCommand(title, bucket, description, ref);
  }

  if (intent === 'edit') {
    // Title and description are optional, but at least one must be present.
    let title: string | undefined;
    if (Object.hasOwn(record, 'title')) {
      const parsedTitle = boundedString('title', kMagicMaxTitleLength);
      if (parsedTitle === null) return null;
      title = parsedTitle;
    }
    let description: string | undefined;
    if (Object.hasOwn(record, 'description')) {
      const parsedDescription = boundedString('description', kMagicMaxDescriptionLength);
      if (parsedDescription === null) return null;
      description = parsedDescription;
    }
    if (title === undefined && description === undefined) {
      fail('missingEditPayload', 'Команда edit требует хотя бы одно из полей "title" или "description".');
      return null;
    }
    if (target === null) return null;
    return canonicalEditCommand(target, title, description);
  }

  // delete / complete / uncomplete / move_to_* — nothing but the target.
  return target !== null ? canonicalTargetCommand(intent as TargetedIntent, target) : null;
}
