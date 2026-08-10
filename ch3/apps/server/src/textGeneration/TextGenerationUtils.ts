import { TextGenerationError } from "@ch3tools/contracts";
import { extractJsonObject } from "@ch3tools/shared/schemaJson";
import * as Schema from "effect/Schema";

const isTextGenerationError = Schema.is(TextGenerationError);

/** Convert an Effect Schema to a flat JSON Schema object, inlining `$defs` when present. */
export function toJsonSchemaObject(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return { ...document.schema, $defs: document.definitions };
  }
  return document.schema;
}

/** Truncate a text section to `maxChars`, appending a `[truncated]` marker when needed. */
export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

/** Normalise a raw commit subject to imperative-mood, ≤72 chars, no trailing period. */
export function sanitizeCommitSubject(raw: string): string {
  const singleLine =
    unwrapGeneratedJsonField(raw, "subject").trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

/** Normalise a raw PR title to a single line with a sensible fallback. */
export function sanitizePrTitle(raw: string): string {
  const singleLine = unwrapGeneratedJsonField(raw, "title").trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

/** A thread title is scanned, not read: keep it under a glance's worth of words. */
const MAX_THREAD_TITLE_WORDS = 6;

/**
 * How many layers of wrapping to peel before giving up. Three covers every
 * shape seen in the wild — fenced, quoted, doubly encoded — and the bound
 * exists so a crafted payload cannot spin here.
 */
const MAX_GENERATED_FIELD_UNWRAPS = 3;

const SURROUNDING_QUOTES_PATTERN = /^['"`]+|['"`]+$/g;
/** A fence's language tag: letters, then whitespace. Two disjoint classes, so
    it cannot backtrack. */
const FENCE_LANGUAGE_PATTERN = /^[A-Za-z]*[ \t]*\r?\n?/;

/** Removes one ``` fence, keeping whatever sat between the markers. */
function stripCodeFence(value: string): string {
  if (!value.startsWith("```")) {
    return value;
  }
  const body = value.slice(3).replace(FENCE_LANGUAGE_PATTERN, "");
  const closingIndex = body.lastIndexOf("```");
  return (closingIndex === -1 ? body : body.slice(0, closingIndex)).trim();
}

/**
 * Peels a JSON envelope off a generated field.
 *
 * Every provider asks for structured output and hands us the decoded value,
 * so this should never be needed — but a model can answer a request for
 * `{"title": string}` by putting the JSON *inside* the string, and the decode
 * succeeds because the type still matches. The sidebar then shows a literal
 * `{"title":"latimsumpus"}`.
 *
 * Three wrappings have to come off, and the order matters: the payload can
 * arrive fenced, quoted, or trailed by chatter the model added after the
 * object. `extractJsonObject` is what handles that last one — parsing the
 * whole string would simply throw and leave the envelope in place.
 *
 * Unwrapping here rather than in one provider covers all five, since this is
 * the single funnel every generated field passes through.
 */
function unwrapGeneratedJsonField(raw: string, field: string): string {
  let value = raw.trim();
  for (let attempt = 0; attempt < MAX_GENERATED_FIELD_UNWRAPS; attempt += 1) {
    const unfenced = stripCodeFence(value).trim();
    // A JSON string literal: the payload survived one encoding too many.
    if (unfenced.startsWith('"')) {
      try {
        const decoded: unknown = JSON.parse(unfenced);
        if (typeof decoded === "string") {
          value = decoded.trim();
          continue;
        }
      } catch {
        // Not a JSON string — fall through to the plain quote strip.
      }
    }
    const candidate = unfenced.replace(SURROUNDING_QUOTES_PATTERN, "").trim();
    if (!candidate.startsWith("{")) {
      return candidate;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonObject(candidate));
    } catch {
      return candidate;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)[field] !== "string"
    ) {
      return candidate;
    }
    value = ((parsed as Record<string, unknown>)[field] as string).trim();
  }
  return value.trim();
}

/** Normalise a raw thread title to a compact single-line sidebar-safe label. */
export function sanitizeThreadTitle(raw: string): string {
  const normalized = unwrapGeneratedJsonField(raw, "title")
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized || normalized.trim().length === 0) {
    return "New thread";
  }

  // The prompt asks for at most 6 words, but a model can ignore it and a long
  // title is exactly what makes a sidebar unreadable. Cap words here so the
  // limit holds regardless of which provider or model generated the title.
  const words = normalized.split(" ");
  const wordCapped =
    words.length > MAX_THREAD_TITLE_WORDS
      ? words.slice(0, MAX_THREAD_TITLE_WORDS).join(" ")
      : normalized;

  if (wordCapped.length <= 50) {
    return wordCapped;
  }

  return `${wordCapped.slice(0, 47).trimEnd()}...`;
}

/**
 * The Claude CLI prints this notice to stderr on *every* `-p` invocation
 * against a directory whose `hasTrustDialogAccepted` flag is false in the
 * active `CLAUDE_CONFIG_DIR`'s config — including ones that go on to
 * succeed (verified directly: identical stderr on a 0-exit run and a
 * non-zero one). Left in place, it silently wins the `stderrDetail.length >
 * 0` check in `runClaudeJson` on every real failure too, so whatever
 * actually broke — auth, rate limit, a crash — never reaches the user or
 * the logs. Strip it before it is used as failure detail so a genuine error
 * message (elsewhere in stderr, or nothing left at all) surfaces instead.
 */
const CLAUDE_WORKSPACE_TRUST_NOTICE_PATTERN =
  /^Ignoring \d+ permissions\.allow entries from .*workspace has not been trusted\..*$/gm;

/** Remove the benign workspace-trust notice from Claude CLI stderr output. */
export function stripClaudeWorkspaceTrustNotice(stderr: string): string {
  return stderr.replace(CLAUDE_WORKSPACE_TRUST_NOTICE_PATTERN, "").trim();
}

/** CLI name to human-readable label, e.g. "codex" → "Codex CLI (`codex`)" */
function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

/**
 * Normalize an unknown error from a CLI text generation process into a
 * typed `TextGenerationError`. Parameterized by CLI name so both Codex
 * and Claude (and future providers) can share the same logic.
 */
export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (isTextGenerationError(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: fallback,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}
