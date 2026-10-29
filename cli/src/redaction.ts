export const REDACTED = "[REDACTED]";

export function isSensitiveField(field: string): boolean {
  const name = field.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (
    ["publickey", "serversignpublickey", "serversignpublickeyb64", "hotkey", "hotkeyrun"].includes(
      name
    )
  )
    return false;
  return (
    /(?:password|passwd|passphrase|privatekey|clientsecret|secretkey|apikey|accesskey|signingkey|encryptionkey|hmackey|authkey|baaskey|loginkey|providerkey|licensekey)/.test(
      name
    ) ||
    /(?:token|secret|authorization|cookies?|credentials?)$/.test(name) ||
    [
      "key",
      "pwd",
      "sessionid",
      "sessionkey",
      "cdk",
      "mirrorccdk",
      "mirrorcdk",
      "pushjson",
      "pushserverchan",
      "pushfeishu",
      "pushwecom",
      "pushtelegramchatid",
    ].includes(name)
  );
}

function sensitivePath(path: unknown): boolean {
  if (typeof path !== "string") return false;
  return path
    .split("/")
    .some((segment) => isSensitiveField(segment.replace(/~1/g, "/").replace(/~0/g, "~")));
}

export interface Redactor {
  text(value: string): string;
  value(value: unknown): unknown;
  arguments(action: string, args: Record<string, unknown>): Record<string, unknown>;
  result(action: string, args: Record<string, unknown>, result: unknown): unknown;
  stream(): { push(chunk: string): string; flush(): string };
}

/** Make a run-local redactor; learned credentials never enter persistent storage. */
export function createRedactor(secrets: Array<string | undefined> = []): Redactor {
  const known = new Set(
    secrets.filter(
      (secret): secret is string =>
        typeof secret === "string" && secret.length > 0 && secret !== REDACTED
    )
  );
  const remember = (value: unknown, seen = new WeakSet<object>(), depth = 0) => {
    if (typeof value === "string") {
      if (value.length >= 4 && value !== REDACTED) known.add(value);
    } else if (value && typeof value === "object" && depth < 32 && !seen.has(value)) {
      seen.add(value);
      for (const nested of Object.values(value).slice(0, 10_000)) remember(nested, seen, depth + 1);
    }
  };
  const discover = (value: unknown, seen = new WeakSet<object>(), depth = 0) => {
    if (!value || typeof value !== "object" || depth > 32 || seen.has(value)) return;
    seen.add(value);
    const pointerValue = sensitivePath((value as Record<string, unknown>).path);
    for (const [key, nested] of Object.entries(value).slice(0, 10_000)) {
      if (isSensitiveField(key) || (pointerValue && ["value", "before", "after"].includes(key)))
        remember(nested);
      else discover(nested, seen, depth + 1);
    }
  };
  const assignments =
    /(["']?)([A-Za-z][\w-]{0,80})\1(\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/g;
  const text = (input: string): string => {
    const trimmed = input.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.stringify(sanitize(JSON.parse(trimmed)));
      } catch {
        /* Ordinary error text and partial JSON still use the text scrubber. */
      }
    }
    let value = input;
    value = value.replace(
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
      REDACTED
    );
    value = value.replace(/\b(authorization\s*:\s*)(?:Basic|Bearer)\s+[^\s,;]+/gi, `$1${REDACTED}`);
    value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
    value = value.replace(/\b((?:set-cookie|cookie)\s*:\s*)[^\r\n]*/gi, `$1${REDACTED}`);
    value = value.replace(
      /\b((?:https?|wss?|socks[45]?):\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,
      `$1${REDACTED}@`
    );
    value = value.replace(
      /([?&])([A-Za-z][\w-]*)=([^&#\s"']*)/g,
      (match, separator: string, key: string) =>
        isSensitiveField(key) ? `${separator}${key}=${REDACTED}` : match
    );
    value = value.replace(/(\/bot)\d{5,}:[A-Za-z0-9_-]+/g, `$1${REDACTED}`);
    value = value.replace(
      /(https?:\/\/(?:open\.feishu\.cn|open\.larksuite\.com)\/open-apis\/bot\/v2\/hook\/)[^\s?#"']+/gi,
      `$1${REDACTED}`
    );
    value = value.replace(
      /(https?:\/\/(?:hooks\.slack\.com\/services|(?:discord(?:app)?\.com)\/api\/webhooks)\/)[^\s?#"']+/gi,
      `$1${REDACTED}`
    );
    value = value.replace(
      assignments,
      (match, quote: string, key: string, separator: string, raw: string) => {
        if (!isSensitiveField(key) || raw === '""' || raw === "''" || raw === "null") return match;
        const token = /^["']/.test(raw) ? raw.slice(1, -1) : raw;
        remember(token);
        return `${quote}${key}${quote}${separator}${/^["']/.test(raw) ? `"${REDACTED}"` : REDACTED}`;
      }
    );
    for (const secret of [...known].sort((left, right) => right.length - left.length))
      value = value.split(secret).join(REDACTED);
    return value;
  };
  const hidden = (value: unknown): unknown =>
    value === "" || value === null || value === undefined ? value : REDACTED;
  const sanitize = (input: unknown): unknown => {
    discover(input);
    const seen = new WeakSet<object>();
    let nodes = 0;
    const walk = (value: unknown, depth: number): unknown => {
      if (++nodes > 10_000 || depth > 32) return "[TRUNCATED]";
      if (typeof value === "string")
        return text(value.slice(0, 65_536)) + (value.length > 65_536 ? "[TRUNCATED]" : "");
      if (!value || typeof value !== "object")
        return typeof value === "bigint" ? String(value) : value;
      if (seen.has(value)) return "[CIRCULAR]";
      seen.add(value);
      const pointerValue = sensitivePath((value as Record<string, unknown>).path);
      const result = Array.isArray(value)
        ? value.slice(0, 10_000).map((nested) => walk(nested, depth + 1))
        : Object.fromEntries(
            Object.entries(value)
              .slice(0, 10_000)
              .map(([key, nested]) => [
                key,
                isSensitiveField(key) ||
                (pointerValue && ["value", "before", "after"].includes(key))
                  ? hidden(nested)
                  : walk(nested, depth + 1),
              ])
          );
      seen.delete(value);
      return result;
    };
    return walk(input, 0);
  };
  const args = (action: string, input: Record<string, unknown>): Record<string, unknown> => {
    if (action === "config_set" && sensitivePath(input.path))
      for (const key of ["value", "before", "after"]) remember(input[key]);
    const result = sanitize(input) as Record<string, unknown>;
    if (action === "config_set" && sensitivePath(input.path))
      for (const key of ["value", "before", "after"])
        if (Object.hasOwn(input, key)) result[key] = hidden(input[key]);
    return result;
  };
  return {
    text,
    value: sanitize,
    arguments: args,
    result: (action, input, result) => {
      args(action, input);
      if (action === "config_get" && sensitivePath(input.path)) {
        remember(result);
        return hidden(result);
      }
      return sanitize(result);
    },
    stream: () => {
      let buffer = "";
      return {
        push: (chunk) => {
          buffer += chunk;
          const tail = Math.max(64, ...[...known].map((secret) => secret.length));
          let cut = buffer.length - tail;
          if (cut <= 0) return "";
          // Keep an unfinished ASCII token (or a known secret spanning the cut)
          // together, so provider chunk boundaries cannot expose credentials.
          while (cut > 0 && /[A-Za-z0-9_~+/.=:-]/.test(buffer[cut - 1])) cut--;
          for (const match of buffer.matchAll(new RegExp(assignments.source, "g"))) {
            if (
              isSensitiveField(match[2]) &&
              match.index < cut &&
              match.index + match[0].length > cut
            )
              cut = match.index;
          }
          for (const match of buffer.matchAll(
            /\b(?:Bearer\s+[^\s,;]+|(?:set-cookie|cookie)\s*:\s*[^\r\n]*)/gi
          )) {
            if (match.index < cut && match.index + match[0].length > cut) cut = match.index;
          }
          for (const secret of known) {
            const start = buffer.lastIndexOf(secret, cut);
            if (start >= 0 && start < cut && start + secret.length > cut) cut = start;
          }
          if (!cut) return "";
          const ready = text(buffer.slice(0, cut));
          buffer = buffer.slice(cut);
          return ready;
        },
        flush: () => {
          const ready = text(buffer);
          buffer = "";
          return ready;
        },
      };
    },
  };
}
