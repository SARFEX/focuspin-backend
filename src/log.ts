import type { LogLevel } from './config.ts';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Структурный JSON-лог в stdout. Никаких сырых идентификаторов и содержимого сообщений — только хеши-префиксы и счётчики. */
export class Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly fields: Record<string, unknown> = {},
  ) {}

  child(fields: Record<string, unknown>): Logger {
    return new Logger(this.level, { ...this.fields, ...fields });
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...this.fields, ...fields });
    process.stdout.write(line + '\n');
  }
}
