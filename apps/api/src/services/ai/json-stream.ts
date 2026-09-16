/**
 * An incremental reader for the one JSON object Scribble's narration call
 * returns.
 *
 * The model is asked for `{ intro, picks: [{ id, reason }] }`. Streaming its
 * raw deltas to a browser would stream JSON fragments, which are useless to a
 * UI -- so this turns the byte stream into two semantic events: the intro once
 * its string closes, and one pick per object as it closes.
 *
 * It is a byte-wise scanner over an accumulating buffer rather than a regex or
 * a `JSON.parse` attempt per delta, because a delta is whatever a single
 * NDJSON line happened to carry: a chunk boundary lands mid-uuid, mid-escape
 * or between a key and its colon often enough that anything else is wrong
 * intermittently, which is the worst way for a parser to be wrong.
 */

export type NarrationEvent =
  | { type: "intro"; text: string }
  | { type: "pick"; id: string; reason: string };

/** Reads the JSON string starting at `start` (the opening quote). */
function readString(
  buffer: string,
  start: number,
): { value: string; end: number } | null {
  if (buffer[start] !== '"') return null;

  let index = start + 1;
  while (index < buffer.length) {
    const char = buffer[index];
    // A backslash escapes the next character, whatever it is -- including a
    // quote, which is the case that makes a naive indexOf('"') wrong.
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"') {
      try {
        return {
          value: JSON.parse(buffer.slice(start, index + 1)) as string,
          end: index + 1,
        };
      } catch {
        // A truncated escape (`\u12` so far) is not yet parseable. Wait.
        return null;
      }
    }
    index += 1;
  }

  return null;
}

/**
 * Finds the end of the object opening at `start`, or null while it is still
 * incomplete. Brace counting has to ignore braces inside strings, or a
 * `reason` mentioning one ends the object early.
 */
function readObjectEnd(buffer: string, start: number): number | null {
  if (buffer[start] !== "{") return null;

  let depth = 0;
  let index = start;
  let inString = false;

  while (index < buffer.length) {
    const char = buffer[index];

    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }

    index += 1;
  }

  return null;
}

export interface NarrationScanner {
  /** Feeds a delta and returns whatever became complete because of it. */
  push(delta: string): NarrationEvent[];
  /** Everything received so far, for the final whole-object validation. */
  text(): string;
}

export function createNarrationScanner(): NarrationScanner {
  let buffer = "";
  let introDone = false;
  /** Index just past the `[` of the picks array; null until it is seen. */
  let cursor: number | null = null;

  function takeIntro(): NarrationEvent[] {
    const key = buffer.indexOf('"intro"');
    if (key === -1) return [];

    const colon = buffer.indexOf(":", key + 7);
    if (colon === -1) return [];

    let at = colon + 1;
    while (at < buffer.length && /\s/.test(buffer[at] as string)) at += 1;
    if (at >= buffer.length) return [];

    const read = readString(buffer, at);
    if (!read) return [];

    introDone = true;
    return read.value ? [{ type: "intro", text: read.value }] : [];
  }

  function takePicks(): NarrationEvent[] {
    if (cursor === null) {
      const key = buffer.indexOf('"picks"');
      if (key === -1) return [];
      const open = buffer.indexOf("[", key + 7);
      if (open === -1) return [];
      cursor = open + 1;
    }

    const events: NarrationEvent[] = [];

    for (;;) {
      const open = buffer.indexOf("{", cursor);
      if (open === -1) return events;

      const end = readObjectEnd(buffer, open);
      if (end === null) return events;

      cursor = end;

      try {
        const parsed = JSON.parse(buffer.slice(open, end)) as unknown;
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          typeof (parsed as { id?: unknown }).id === "string"
        ) {
          const { id, reason } = parsed as { id: string; reason?: unknown };
          events.push({
            type: "pick",
            id,
            reason: typeof reason === "string" ? reason : "",
          });
        }
      } catch {
        // A complete-looking object that does not parse is skipped rather
        // than fatal: the terminal whole-object validation is the authority.
      }
    }
  }

  return {
    push(delta) {
      buffer += delta;
      const events: NarrationEvent[] = [];
      if (!introDone) events.push(...takeIntro());
      events.push(...takePicks());
      return events;
    },
    text: () => buffer,
  };
}
