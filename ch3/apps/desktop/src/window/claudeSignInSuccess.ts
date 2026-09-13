/**
 * Recognising the page Claude shows once a sign-in is done, so the window that
 * reached it closes itself.
 *
 * The flow already closes on a `localhost` callback navigation, but that is not
 * where every sign-in ends: the CLI's success page is hosted ("Sign in
 * successful | Claude Platform", "Build something great … You can now close
 * this window"), and a person who finished the consent by hand was left staring
 * at it with the window still open. This recognises that terminal page — by its
 * title and by its body text, in every language it is served in — so both the
 * automated and the manual paths end the same way: the window closes on its own.
 *
 * By content, not by URL: the success URL carries the authorization code, and a
 * URL is a credential. A title and a run of body text carry none, and a boolean
 * "does this look like the success page" is all the caller needs.
 *
 * @module claudeSignInSuccess
 */

/**
 * Phrases that only the post-sign-in page shows, lower-cased for a
 * case-insensitive `includes`. English and Spanish, because Anthropic renders
 * this in the account's own locale and CH3 accounts are Spanish. Each is
 * distinctive enough that no consent or address page carries it.
 */
export const CLAUDE_SIGN_IN_SUCCESS_MARKERS: ReadonlyArray<string> = [
  // English
  "sign in successful",
  "sign-in successful",
  "you can now close this window",
  "you're all set up for claude",
  "you are all set up for claude",
  "build something great",
  // Spanish
  "inicio de sesión correcto",
  "inicio de sesion correcto",
  "sesión iniciada correctamente",
  "sesion iniciada correctamente",
  "ya puedes cerrar esta ventana",
  "puedes cerrar esta ventana",
  "todo listo para claude",
];

/**
 * Whether a piece of text — a window title, or a page's visible body — is the
 * sign-in success page. Empty and whitespace never match, so a page that has
 * not set a title yet does not close a window early.
 */
export function matchesClaudeSignInSuccess(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const haystack = text.toLowerCase();
  return CLAUDE_SIGN_IN_SUCCESS_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * A script that answers, as a boolean, whether the page it runs in is the
 * success page — read from the title and the visible body text, never
 * returning either. Injected into the sign-in window's own page, which by this
 * point is a terminal "you're done" screen, so it carries nothing to leak.
 */
export function buildClaudeSignInSuccessProbeScript(): string {
  const markers = JSON.stringify(CLAUDE_SIGN_IN_SUCCESS_MARKERS);
  return `(() => {
  try {
    const MARKERS = ${markers};
    const title = (document.title || "").toLowerCase();
    const body = (document.body && document.body.innerText ? document.body.innerText : "").toLowerCase();
    for (const marker of MARKERS) {
      if (title.indexOf(marker) !== -1 || body.indexOf(marker) !== -1) return true;
    }
    return false;
  } catch {
    return false;
  }
})();`;
}
