import { assert, describe, it } from "@effect/vitest";
import { beforeEach } from "vite-plus/test";

import {
  CLAUDE_SIGN_IN_HINT_TTL_MS,
  clearClaudeSignInEmailHint,
  consumeClaudeSignInEmail,
  rememberClaudeSignInEmail,
} from "./claudeSignInEmailHint.ts";

const T0 = 1_760_000_000_000;

describe("claudeSignInEmailHint", () => {
  beforeEach(() => {
    clearClaudeSignInEmailHint();
  });

  it("hands the remembered address to the window that opens next", () => {
    rememberClaudeSignInEmail("someone@example.com", T0);
    assert.deepStrictEqual(consumeClaudeSignInEmail(T0 + 500), {
      email: "someone@example.com",
    });
  });

  it("is single use, so one hint cannot prefill two sign-ins", () => {
    // The second window is a different attempt, quite possibly for a different
    // account. Inheriting the first one's address is the exact mistake this
    // feature exists to prevent.
    rememberClaudeSignInEmail("someone@example.com", T0);
    assert.strictEqual(consumeClaudeSignInEmail(T0)?.email, "someone@example.com");
    assert.isUndefined(consumeClaudeSignInEmail(T0));
  });

  it("expires, so an abandoned sign-in cannot bequeath its address", () => {
    // A sign-in that never opened a window — the CLI returned no URL, or the
    // user walked away — would otherwise leave an address parked indefinitely.
    rememberClaudeSignInEmail("someone@example.com", T0);
    assert.isUndefined(consumeClaudeSignInEmail(T0 + CLAUDE_SIGN_IN_HINT_TTL_MS + 1));
  });

  it("survives right up to the deadline", () => {
    rememberClaudeSignInEmail("someone@example.com", T0);
    assert.strictEqual(
      consumeClaudeSignInEmail(T0 + CLAUDE_SIGN_IN_HINT_TTL_MS)?.email,
      "someone@example.com",
    );
  });

  it("treats null as 'nothing to prefill', clearing what was pending", () => {
    // How the renderer says "this one is a brand-new account". It must also
    // wipe a previous attempt's address rather than leave it to be inherited.
    rememberClaudeSignInEmail("someone@example.com", T0);
    rememberClaudeSignInEmail(null, T0);
    assert.isUndefined(consumeClaudeSignInEmail(T0));
  });

  it("treats a blank or whitespace address as nothing at all", () => {
    rememberClaudeSignInEmail("someone@example.com", T0);
    rememberClaudeSignInEmail("   ", T0);
    assert.isUndefined(consumeClaudeSignInEmail(T0));
  });

  it("trims the address it was handed", () => {
    rememberClaudeSignInEmail("  someone@example.com \n", T0);
    assert.strictEqual(consumeClaudeSignInEmail(T0)?.email, "someone@example.com");
  });

  it("reports nothing when no sign-in named an account", () => {
    assert.isUndefined(consumeClaudeSignInEmail(T0));
  });

  it("replaces a pending hint rather than queueing behind it", () => {
    // Clicking a second account supersedes the first attempt, and the panel
    // says so; the address must follow the click the user actually made last.
    rememberClaudeSignInEmail("first@example.com", T0);
    rememberClaudeSignInEmail("second@example.com", T0 + 10);
    assert.strictEqual(consumeClaudeSignInEmail(T0 + 20)?.email, "second@example.com");
    assert.isUndefined(consumeClaudeSignInEmail(T0 + 20));
  });
});
