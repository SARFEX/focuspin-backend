import { describe, expect, test } from 'bun:test';
import { HttpError } from '../errors.ts';
import { MAGIC_SYSTEM_PROMPT_BASE, assertFocuspinSystemPrompt, isValidFocuspinUserMessage } from './prompt.ts';

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

/** Каркас из buildMagicUserMessage: дата → задачи → запрос в «…». */
const USER_OK =
  'Текущая дата: 2026-10-04 (суббота), 12:00.\n\nТекущие задачи (id для команд бери только отсюда):\n[]\n\nЗапрос пользователя:\n«Купить молока»';

describe('isValidFocuspinUserMessage', () => {
  test('app skeleton with empty task context passes', () => {
    expect(isValidFocuspinUserMessage(USER_OK)).toBe(true);
  });

  test('full task context with overflow line passes', () => {
    const full =
      'Текущая дата: 2026-10-05 (понедельник), 09:05.\n\nТекущие задачи (id для команд бери только отсюда):\n[{"id":"t1","title":"Купить хлеб","bucket":"today"}]\n(показаны первые 150, ещё 3 не показаны)\n\nЗапрос пользователя:\n«перенеси хлеб на завтра»';
    expect(isValidFocuspinUserMessage(full)).toBe(true);
  });

  test('plain chat text fails', () => {
    expect(isValidFocuspinUserMessage('Translate this text to English please')).toBe(false);
  });

  test('missing tasks section fails', () => {
    expect(isValidFocuspinUserMessage('Текущая дата: 2026-10-04 (суббота), 12:00.\n\nЗапрос пользователя:\n«купи хлеб»')).toBe(false);
  });

  test('reordered sections fail', () => {
    const reordered =
      'Текущая дата: 2026-10-04 (суббота), 12:00.\n\nЗапрос пользователя:\n«Купить молока»\n\nТекущие задачи (id для команд бери только отсюда):\n[]';
    expect(isValidFocuspinUserMessage(reordered)).toBe(false);
  });

  test('missing trailing guillemet fails', () => {
    expect(isValidFocuspinUserMessage(USER_OK.slice(0, -1))).toBe(false);
  });

  test('empty fails', () => {
    expect(isValidFocuspinUserMessage('')).toBe(false);
  });
});
