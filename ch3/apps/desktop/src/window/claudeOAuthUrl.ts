/**
 * Which URLs the Claude account sign-in owns.
 *
 * This lives on its own, with no imports, for two reasons: the desktop
 * window-open handler and the live Electron harness that proves the handler
 * works must test the SAME function — a harness that reimplements the rule
 * proves nothing — and a rule this load-bearing should be readable without
 * reading the window module around it.
 */

/**
 * Every host the Claude CLI has handed back a sign-in URL on. The CLI moved
 * the flow from `claude.ai/oauth/authorize` to `claude.com/cai/oauth/authorize`
 * without warning, and a predicate pinned to the old host sent the sign-in
 * straight out to the system browser — the exact failure this interception
 * exists to prevent. Accept the family, not one address.
 */
export const CLAUDE_OAUTH_HOSTS: ReadonlySet<string> = new Set([
  // The personal-subscription scope, CLAUDE_AI_AUTHORIZE_URL: today
  // `claude.com/cai/oauth/authorize`, historically `claude.ai/oauth/authorize`.
  "claude.ai",
  "claude.com",
  // The API-key/console scope, CONSOLE_AUTHORIZE_URL:
  // `platform.claude.com/oauth/authorize`.
  "platform.claude.com",
]);

export function isClaudeOAuthSignInUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    if (!CLAUDE_OAUTH_HOSTS.has(url.hostname)) return false;
    // Match the `oauth` path SEGMENT rather than a prefix: the current URL
    // carries it one level down (`/cai/oauth/authorize`), so `startsWith`
    // missed it. A marketing page that merely mentions oauth in a slug does
    // not contain the segment, so it still opens externally as before.
    return url.pathname === "/oauth" || url.pathname.includes("/oauth/");
  } catch {
    return false;
  }
}
