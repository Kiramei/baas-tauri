export type ScriptLogTokenKind =
  | "plain"
  | "heading"
  | "key"
  | "identifier"
  | "string"
  | "path"
  | "number"
  | "literal";

export interface ScriptLogToken {
  kind: ScriptLogTokenKind;
  text: string;
}

// Highlighting is presentation only. An unusually large record stays intact as
// plain text, avoiding excessive parser work and span creation in the live log.
const MAX_HIGHLIGHT_LENGTH = 32_768;
const MAX_HIGHLIGHT_TOKENS = 512;
const WORD_CHARACTER = /[\p{L}\p{M}\p{N}_]/u;
const KEY = /[A-Za-z_][A-Za-z0-9_ ./-]{0,78}(?=[\t ]*[:=])/y;
const URL = /(?:https?|wss?):\/\/[^\s<>"']+/iy;
const WINDOWS_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\t\r\n<>:"|?*,;{}]+/y;
const RELATIVE_PATH = /\.{1,2}[\\/][^\s<>"'|,;{}]+/y;
const UNIX_PATH = /\/(?:[A-Za-z_.][^\s<>"'|,;{}]*)/y;
const DATE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?)?/y;
const TIME = /\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?/y;
const ADDRESS = /\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?/y;
const COORDINATES = /\([+-]?\d+(?:\.\d+)?[\t ]*,[\t ]*[+-]?\d+(?:\.\d+)?\)/y;
const LITERAL = /(?:True|False|None|true|false|null)/y;
const CONTEXT_IDENTIFIER = /[\p{L}\p{N}_][\p{L}\p{M}\p{N}_.-]*/uy;
const NAMED_IDENTIFIER =
  /(?:[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){2,}|[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+)/y;
const NUMBER =
  /(?:0x[\da-fA-F]+|[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?(?:\/\d+|[\t ]*(?:ns|us|µs|μs|ms|min|s|h)(?![\p{L}\p{M}\p{N}_])|%)?)/uy;

const matchAt = (pattern: RegExp, message: string, index: number): string | undefined => {
  pattern.lastIndex = index;
  return pattern.exec(message)?.[0];
};

const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && WORD_CHARACTER.test(character);

const endsAtBoundary = (message: string, index: number, value: string): boolean => {
  const end = index + value.length;
  return (
    !isWordCharacter(message[end]) && (message[end] !== "." || !isWordCharacter(message[end + 1]))
  );
};

/** Returns the closing quote, or the line end for an unterminated string. */
const quotedEnd = (message: string, start: number): { end: number; closed: boolean } => {
  const quote = message[start];
  for (let index = start + 1; index < message.length; index += 1) {
    const character = message[index];
    if (character === "\r" || character === "\n") return { end: index, closed: false };
    if (character === "\\") {
      // Escapes remain literal. Do not consume a newline with a trailing slash.
      if (message[index + 1] !== "\r" && message[index + 1] !== "\n") index += 1;
    } else if (character === quote) {
      return { end: index + 1, closed: true };
    }
  }
  return { end: message.length, closed: false };
};

/**
 * A small log lexer, not a language parser. Protected values are consumed whole
 * before keys and numbers; ordinary prose and severity words keep their color.
 * Every returned text fragment is an unmodified slice of the original message.
 */
export const tokenizeScriptLog = (message: string): ScriptLogToken[] => {
  if (message.length === 0) return [];
  if (message.length > MAX_HIGHLIGHT_LENGTH) return [{ kind: "plain", text: message }];

  const tokens: ScriptLogToken[] = [];
  let index = 0;
  let plainStart = 0;
  let lineStart = 0;
  let lineHasContent = false;
  let afterPipe = false;
  let identifierExpected = false;

  const emit = (kind: ScriptLogTokenKind, text: string) => {
    if (plainStart < index) tokens.push({ kind: "plain", text: message.slice(plainStart, index) });
    tokens.push({ kind, text });
    index += text.length;
    plainStart = index;
    lineHasContent = true;
    afterPipe = false;
    identifierExpected = false;
  };

  while (index < message.length) {
    if (tokens.length >= MAX_HIGHLIGHT_TOKENS) break;
    const character = message[index];
    if (index === lineStart) {
      const newline = message.indexOf("\n", index);
      const end = newline === -1 ? message.length : newline;
      const line = message.slice(index, end);
      const title = line.trim();
      if (title.length >= 7 && title.startsWith("---") && title.endsWith("---")) {
        emit("heading", line);
        continue;
      }
    }

    if (character === "\n") {
      lineStart = index + 1;
      lineHasContent = false;
      afterPipe = false;
      identifierExpected = false;
      index += 1;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      index += 1;
      continue;
    }

    const boundary = !isWordCharacter(message[index - 1]) && message[index - 1] !== ".";
    if (boundary) {
      const url = matchAt(URL, message, index);
      if (url) {
        emit("path", url);
        continue;
      }
      const path =
        matchAt(WINDOWS_PATH, message, index)?.trimEnd() ??
        matchAt(RELATIVE_PATH, message, index) ??
        matchAt(UNIX_PATH, message, index);
      if (path) {
        emit("path", path);
        continue;
      }
      const protectedValue =
        matchAt(DATE, message, index) ??
        matchAt(TIME, message, index) ??
        matchAt(ADDRESS, message, index);
      if (protectedValue && endsAtBoundary(message, index, protectedValue)) {
        emit("literal", protectedValue);
        continue;
      }
    }

    if ((character === '"' || character === "'") && !isWordCharacter(message[index - 1])) {
      const quoted = quotedEnd(message, index);
      if (quoted.closed) {
        emit(identifierExpected ? "identifier" : "string", message.slice(index, quoted.end));
      } else {
        // Consume a malformed string once rather than repeatedly scanning its tail.
        index = quoted.end;
        lineHasContent = true;
        identifierExpected = false;
      }
      continue;
    }

    if ((!lineHasContent || afterPipe) && boundary) {
      const key = matchAt(KEY, message, index)?.trimEnd();
      if (key) {
        emit("key", key);
        identifierExpected = /task|feature|package|activity|server/i.test(key);
        continue;
      }
    }

    const coordinates = character === "(" ? matchAt(COORDINATES, message, index) : undefined;
    if (coordinates) {
      emit("number", coordinates);
      continue;
    }

    if (boundary) {
      const literal = matchAt(LITERAL, message, index);
      if (literal && endsAtBoundary(message, index, literal)) {
        emit("literal", literal);
        continue;
      }
      const identifier = identifierExpected
        ? matchAt(CONTEXT_IDENTIFIER, message, index)
        : matchAt(NAMED_IDENTIFIER, message, index);
      if (identifier && endsAtBoundary(message, index, identifier)) {
        emit("identifier", identifier);
        continue;
      }
      const number = matchAt(NUMBER, message, index);
      if (number && endsAtBoundary(message, index, number)) {
        emit("number", number);
        continue;
      }
    }

    if (character === "|") {
      afterPipe = true;
      identifierExpected = false;
    } else {
      lineHasContent = true;
      if (character !== ":" && character !== "=" && character !== "[" && character !== "(") {
        afterPipe = false;
        identifierExpected = false;
      }
    }
    index += 1;
  }

  if (plainStart < message.length) tokens.push({ kind: "plain", text: message.slice(plainStart) });
  return tokens;
};
