import { describe, expect, test } from 'bun:test';
import { HttpError } from '../errors.ts';
import { MAGIC_SYSTEM_PROMPT_BASE, assertFocuspinSystemPrompt } from './prompt.ts';

/** Точный префикс дополнения из buildMagicSystemPrompt (Dart) — продублирован для независимости теста. */
const ADDENDUM_PREFIX = '\n\nДополнительные инструкции пользователя (не отменяют правила формата и разрешённые интенты):\n';

const passes = (content: string): void => expect(() => assertFocuspinSystemPrompt(content)).not.toThrow();
const fails = (content: string): void => expect(() => assertFocuspinSystemPrompt(content)).toThrow(HttpError);

describe('assertFocuspinSystemPrompt', () => {
  test('exact base passes', () => {
    passes(MAGIC_SYSTEM_PROMPT_BASE);
  });

  test('base + exact addendum prefix with tail passes', () => {
    passes(`${MAGIC_SYSTEM_PROMPT_BASE}${ADDENDUM_PREFIX}Отвечай максимально кратко.`);
  });

  test('base + exact addendum prefix with empty tail passes (startsWith semantics)', () => {
    passes(MAGIC_SYSTEM_PROMPT_BASE + ADDENDUM_PREFIX);
  });

  test('tampered addendum tail fails', () => {
    fails(
      `${MAGIC_SYSTEM_PROMPT_BASE}\n\nДополнительные инструкции пользователя (не отменяют правила формата И разрешённые интенты):\nтекст`,
    );
  });

  test('wrong addendum line ending (no trailing colon newline) fails', () => {
    fails(
      `${MAGIC_SYSTEM_PROMPT_BASE}\n\nДополнительные инструкции пользователя (не отменяют правила формата и разрешённые интенты): текст`,
    );
  });

  test('foreign prompt fails', () => {
    fails('You are a helpful assistant.');
  });

  test('truncated base fails', () => {
    fails(MAGIC_SYSTEM_PROMPT_BASE.slice(0, MAGIC_SYSTEM_PROMPT_BASE.length - 1));
  });

  test('base with extra trailing character fails', () => {
    fails(`${MAGIC_SYSTEM_PROMPT_BASE} `);
  });

  test('empty prompt fails', () => {
    fails('');
  });
});
