import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Domain Types

export const ProviderSessionIdInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderSessionIdInput = typeof ProviderSessionIdInput.Type;

/**
 * The provider CLI's own conversation id for a thread — the id you hand to
 * `claude --resume`, not CH3's `threadId`.
 *
 * It is stored in the thread's resume cursor, so it is null until the provider
 * has actually started a session, and it changes if that session is replaced.
 */
export const ProviderSessionIdResult = Schema.Struct({
  sessionId: Schema.NullOr(TrimmedNonEmptyString),
  /** Which CLI owns the id, so a caller can label or format it. */
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * Which account the live session is ACTUALLY signed in as
   * (`email|organization`), read from the session rather than from settings.
   *
   * Null when there is no live session, when the provider has no account of
   * this shape (Codex, OpenCode), or when the config directory names nobody.
   * A caller that also knows which account is selected can compare the two and
   * see that a thread is answering from the account the user switched away
   * from.
   */
  accountKey: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProviderSessionIdResult = typeof ProviderSessionIdResult.Type;

// Errors

export class ProviderSessionIdError extends Schema.TaggedErrorClass<ProviderSessionIdError>()(
  "ProviderSessionIdError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
