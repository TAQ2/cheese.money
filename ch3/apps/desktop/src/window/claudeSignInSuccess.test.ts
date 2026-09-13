import { describe, expect, it } from "vite-plus/test";

import { matchesClaudeSignInSuccess } from "./claudeSignInSuccess.ts";

describe("matchesClaudeSignInSuccess", () => {
  it("recognises the success page in English", () => {
    for (const text of [
      "Sign in successful | Claude Platform",
      "Build something great",
      "You're all set up for Claude Code. You can now close this window.",
    ]) {
      expect(matchesClaudeSignInSuccess(text)).toBe(true);
    }
  });

  it("recognises the success page in Spanish", () => {
    for (const text of [
      "Inicio de sesión correcto | Claude Platform",
      "Ya puedes cerrar esta ventana",
      "Todo listo para Claude Code",
    ]) {
      expect(matchesClaudeSignInSuccess(text)).toBe(true);
    }
  });

  it("does not fire on the consent or address pages, or an empty title", () => {
    for (const text of [
      "",
      "   ",
      "Claude",
      "Claude Code desea conectarse a su Claude chat account",
      "Sign in to Claude",
      "Iniciar sesión",
      null,
      undefined,
    ]) {
      expect(matchesClaudeSignInSuccess(text)).toBe(false);
    }
  });
});
