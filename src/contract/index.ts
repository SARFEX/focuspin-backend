export type MagicIntent =
  | 'create'
  | 'edit'
  | 'delete'
  | 'complete'
  | 'uncomplete'
  | 'move_to_tomorrow'
  | 'move_to_today'
  | 'move_to_backlog';

export interface ParseIssue {
  /** Код зеркалит issue-коды lib/magic_input/task_command.dart приложения. */
  code: string;
  message: string;
  commandIndex?: number;
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
  bucket?: 'today' | 'tomorrow' | 'backlog';
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

/**
 * Устойчивое извлечение JSON-кандидата из сырого текста модели — зеркало
 * lib/magic_input/magic_response_parser.dart: обрезка markdown-заборов,
 * поиск первого '{' / '[' с балансом строк и скобок. null — кандидата нет.
 */
export function extractJsonCandidate(rawModelText: string): string | null {
  void rawModelText;
  throw new Error('extractJsonCandidate: not implemented');
}

/**
 * ГАРД: единственный путь сырого текста модели наружу.
 * Извлекает, валидирует по схеме команд v4 (зеркало task_command.dart) и
 * пересобирает канонический JSON. Любое отклонение — { ok: false, issues }.
 */
export function validateMagicContent(rawModelText: string): ContractResult {
  void rawModelText;
  throw new Error('validateMagicContent: not implemented');
}
