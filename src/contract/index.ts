/**
 * CONTRACT GUARD — public API (frozen).
 * Implementation: commands.ts (schema v4, mirror of the app's
 * my-focus-tasks/lib/magic_input/task_command.dart) and parse.ts (resilient
 * extraction, mirror of magic_response_parser.dart).
 */

export type {
  MagicIntent,
  MagicBucket,
  ParseIssue,
  ContractResult,
  TargetById,
  TargetByTitleQuery,
  TargetByRef,
  CommandTarget,
  MagicCommandCreate,
  MagicCommandEdit,
  MagicCommandWithTargetBase,
  MagicCommand,
} from './commands.ts';

export {
  kMagicMaxTitleLength,
  kMagicMaxDescriptionLength,
  kMagicMaxTitleQueryLength,
  kMagicMaxRefLength,
  kMagicMaxCommands,
} from './commands.ts';

/**
 * Устойчивое извлечение JSON-кандидата из сырого текста модели — зеркало
 * lib/magic_input/magic_response_parser.dart: обрезка markdown-заборов,
 * поиск первого '{' / '[' с балансом строк и скобок. null — кандидата нет.
 */
export { extractJsonCandidate } from './parse.ts';

/**
 * ГАРД: единственный путь сырого текста модели наружу.
 * Извлекает, валидирует по схеме команд v4 (зеркало task_command.dart) и
 * пересобирает канонический JSON. Любое отклонение — { ok: false, issues }.
 */
export { validateMagicContent } from './parse.ts';
