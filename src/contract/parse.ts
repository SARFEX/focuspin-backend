/**
 * Resilient JSON extraction from raw model text — a 1:1 mirror of the
 * focuspin app's lib/magic_input/magic_response_parser.dart (private
 * repo). Never throws:
 * empty content, prose and truncated JSON all collapse into issues.
 */

import { parseTaskCommandBatch } from './commands.ts';
import type { ContractResult } from './commands.ts';

/** First ```json ... ``` (or bare ``` ... ```) block, non-greedy, like the Dart regex. */
const FENCED_JSON_RE = /```(?:json)?\s*([\s\S]*?)```/;

/**
 * Resilient extraction of a single JSON candidate from raw model text:
 * trim; strip a markdown fence; otherwise take the first balanced
 * `{...}` / `[...]` fragment (string- and escape-aware); fall back to the
 * slice from the first `{`/`[` to the last `}`/`]`. null — no candidate.
 */
export function extractJsonCandidate(rawModelText: string): string | null {
  const text = rawModelText.trim();
  if (text.length === 0) return null;

  const fenced = FENCED_JSON_RE.exec(text);
  if (fenced !== null) {
    const inner = (fenced[1] ?? '').trim();
    if (inner.length > 0) return inner;
  }

  const balanced = balancedJsonValues(text);
  const first = balanced[0];
  if (first !== undefined) return first;

  const start = firstIndexOfAny(text, ['{', '[']);
  const end = lastIndexOfAny(text, ['}', ']']);
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return null;
}

/**
 * GUARD: the only path raw model text may take out of the backend.
 * Extracts JSON candidates, validates them against the command schema v4
 * (mirror of task_command.dart) and re-serializes canonically. Any
 * deviation — { ok: false, issues }. Raw text never reaches the app.
 */
export function validateMagicContent(rawModelText: string): ContractResult {
  const text = rawModelText.trim();
  if (text.length === 0) {
    return { ok: false, issues: [{ code: 'emptyContent', message: 'Модель вернула пустой ответ.' }] };
  }

  // Candidates are tried in order; the first one that decodes AND passes the
  // schema wins. If several decoded but all failed validation, the issues of
  // the first decoded one are reported (same as the Dart parser).
  let firstDecodedFailure: ContractResult | null = null;
  for (const candidate of jsonCandidates(text)) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(candidate);
    } catch {
      continue; // Not JSON — try the next candidate.
    }
    const parsed = parseTaskCommandBatch(decoded);
    if (parsed.ok) return parsed;
    if (firstDecodedFailure === null) firstDecodedFailure = parsed;
  }

  if (firstDecodedFailure !== null) return firstDecodedFailure;
  const preview = text.slice(0, Math.min(200, text.length));
  return {
    ok: false,
    issues: [{ code: 'invalidJson', message: `В ответе модели не найден JSON: "${preview}"` }],
  };
}

/** JSON candidate texts in priority order, no dedup — mirrors _jsonCandidates in Dart. */
function jsonCandidates(text: string): string[] {
  const candidates: string[] = [text];
  const fenced = FENCED_JSON_RE.exec(text);
  if (fenced !== null) candidates.push((fenced[1] ?? '').trim());
  candidates.push(...balancedJsonValues(text));
  const start = firstIndexOfAny(text, ['{', '[']);
  const end = lastIndexOfAny(text, ['}', ']']);
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  return candidates;
}

/**
 * All balanced top-level JSON objects/arrays in the text: scans from every
 * unconsumed `{`/`[` and closes the fragment when its depth returns to zero.
 * Brackets inside string literals and foreign pairs are not counted —
 * mirrors balancedJsonValues in Dart (only same-type pairs are counted).
 */
function balancedJsonValues(text: string): string[] {
  const fragments: string[] = [];
  let index = 0;
  for (;;) {
    const from = firstIndexOfAny(text, ['{', '['], index);
    if (from === -1) break;
    const opening = text.charAt(from);
    const closing = opening === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = from; i < text.length; i++) {
      const char = text.charAt(i);
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === opening) {
        depth += 1;
      } else if (char === closing) {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break; // Unbalanced opener — the text is exhausted.
    fragments.push(text.slice(from, end + 1));
    index = end + 1;
  }
  return fragments;
}

function firstIndexOfAny(text: string, needles: readonly string[], fromIndex = 0): number {
  let best = -1;
  for (const needle of needles) {
    const index = text.indexOf(needle, fromIndex);
    if (index !== -1 && (best === -1 || index < best)) best = index;
  }
  return best;
}

function lastIndexOfAny(text: string, needles: readonly string[]): number {
  let best = -1;
  for (const needle of needles) {
    const index = text.lastIndexOf(needle);
    if (index > best) best = index;
  }
  return best;
}
