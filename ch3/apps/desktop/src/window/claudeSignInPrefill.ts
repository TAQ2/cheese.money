/**
 * Typing the account's email into the Claude sign-in page for you.
 *
 * When you re-authenticate an account CH3 already knows, it knows the
 * address too — it is sitting in that profile's `.claude.json`. Making you
 * retype it is busywork, and worse, retyping it is where you sign the WRONG
 * account back into a profile, which is silent and confusing to undo.
 *
 * This lives on its own with no imports, for the reason `claudeOAuthUrl.ts`
 * gives: the window handler and the tests must exercise the same source, and a
 * rule this fiddly should be readable without the window module around it.
 *
 * The script is built as a string because it runs INSIDE the sign-in page,
 * which is a third-party origin we cannot import a module into. It is injected
 * from the main process via `webContents.executeJavaScript`, so it needs no
 * preload and no relaxation of the child window's sandbox.
 */

/**
 * Hosts the prefill may type into.
 *
 * The check happens in TWO places and they are not equivalent. The real
 * boundary is {@link isClaudeSignInPrefillUrl}, applied in the main process
 * against the URL Electron reports, before the address is put anywhere near
 * the page — the sign-in window navigates during the flow (an identity
 * provider, then the loopback callback), and a script with the address inlined
 * must not be handed to those origins at all.
 *
 * The copy of the list inside the injected script is a correctness guard only:
 * it runs on the page's own `location` and `Array.prototype.indexOf`, both of
 * which the page can replace, so it can be defeated by the very page it is
 * meant to defend against. It stays because it costs nothing and catches an
 * in-document navigation the outer check cannot see, but nothing security-
 * relevant may rest on it.
 */
export const CLAUDE_SIGN_IN_PREFILL_HOSTS: ReadonlyArray<string> = ["claude.ai", "claude.com"];

/**
 * Whether a page is one the address may be handed to. Applied in the main
 * process, where the URL comes from Electron rather than from the page.
 *
 * Requires https and an exact host match. `www.` and other subdomains are
 * deliberately excluded: the CLI has only ever returned bare-host sign-in
 * URLs, and widening this to a suffix match would let any `*.claude.ai`
 * subdomain — including one the OAuth flow could be redirected to — receive
 * the address.
 */
export function isClaudeSignInPrefillUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && CLAUDE_SIGN_IN_PREFILL_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

/** How long to keep looking for the field before giving up, in milliseconds. */
export const CLAUDE_SIGN_IN_PREFILL_DEADLINE_MS = 15_000;

/** How often to look while waiting for it, in milliseconds. */
export const CLAUDE_SIGN_IN_PREFILL_POLL_MS = 250;

/**
 * Where the email box is, in priority order.
 *
 * A list rather than one selector because the sign-in page is not ours and
 * will be redesigned without telling us. Every entry names the field by a
 * different stable property, so losing one costs a fallback rather than the
 * feature. `type="email"` is first because it is the one that also tells us
 * the field is semantically an address, not merely named like one.
 */
export const CLAUDE_SIGN_IN_EMAIL_SELECTORS: ReadonlyArray<string> = [
  'input[type="email"]',
  'input[name="email"]',
  'input[autocomplete="email"]',
  'input[inputmode="email"]',
  'input[id*="email" i]',
  'input[placeholder*="email" i]',
];

export interface ClaudeSignInPrefillScriptOptions {
  readonly email: string;
  /** Overridable so tests need not wait out the real deadline. */
  readonly deadlineMs?: number;
  readonly pollMs?: number;
}

/**
 * Build the injectable prefill script.
 *
 * Everything interpolated goes through `JSON.stringify`, so an address
 * containing a quote or a backslash cannot break out of its literal and become
 * code. That matters more than it looks: the value originates in a file on
 * disk that CH3 did not write.
 *
 * The script resolves to `true` once it has put the address in the box (or
 * found the user had already typed one), and `false` if the field never
 * appeared, the page was the wrong origin, or another injection was already
 * running. It never submits the form — it fills one field and stops.
 */
export function buildClaudeSignInPrefillScript(options: ClaudeSignInPrefillScriptOptions): string {
  const email = JSON.stringify(options.email);
  const hosts = JSON.stringify([...CLAUDE_SIGN_IN_PREFILL_HOSTS]);
  const selectors = JSON.stringify([...CLAUDE_SIGN_IN_EMAIL_SELECTORS]);
  const deadlineMs = JSON.stringify(options.deadlineMs ?? CLAUDE_SIGN_IN_PREFILL_DEADLINE_MS);
  const pollMs = JSON.stringify(options.pollMs ?? CLAUDE_SIGN_IN_PREFILL_POLL_MS);

  return `(() => {
  const EMAIL = ${email};
  const HOSTS = ${hosts};
  const SELECTORS = ${selectors};
  const DEADLINE_MS = ${deadlineMs};
  const POLL_MS = ${pollMs};

  // One run at a time. The page navigates and reloads during the OAuth flow,
  // and the handler re-injects on each load; without this guard those pile up
  // into several timers racing to fill the same box.
  if (window.__ch3ClaudeEmailPrefillRunning === true) return Promise.resolve(false);
  window.__ch3ClaudeEmailPrefillRunning = true;

  const onSignInOrigin = () => HOSTS.indexOf(location.hostname) !== -1;

  const findEmailInput = () => {
    for (const selector of SELECTORS) {
      let candidate = null;
      try {
        candidate = document.querySelector(selector);
      } catch {
        // A selector this build does not understand is skipped, not fatal.
        continue;
      }
      if (!candidate) continue;
      if (candidate.disabled === true || candidate.readOnly === true) continue;
      if (candidate.type === "hidden") continue;
      return candidate;
    }
    return null;
  };

  const fill = (input) => {
    // React keeps its own record of the last value it wrote to the node.
    // Assigning \`input.value\` directly updates the DOM but leaves that record
    // untouched, so React believes nothing changed, and the next render puts
    // the empty value back — the box looks filled, then submits blank. Going
    // through the prototype's setter and dispatching \`input\` is what makes
    // React see it. This is the whole reason the script is not a one-liner.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(input, EMAIL);
    } else {
      input.value = EMAIL;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let timer = null;

    const finish = (filled) => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      window.__ch3ClaudeEmailPrefillRunning = false;
      resolve(filled);
    };

    const attempt = () => {
      if (!onSignInOrigin()) {
        finish(false);
        return;
      }
      const input = findEmailInput();
      if (input) {
        // Never clobber something already in the box: the user may have begun
        // typing a different account before the field was found, and their
        // keystrokes outrank our guess every time.
        if (String(input.value ?? "").trim().length === 0) {
          fill(input);
        }
        finish(true);
        return;
      }
      if (Date.now() - startedAt >= DEADLINE_MS) {
        finish(false);
      }
    };

    // The page is a single-page app, so the field usually mounts after load.
    // Try once immediately for the case where it is already there, then poll.
    attempt();
    if (timer === null && window.__ch3ClaudeEmailPrefillRunning === true) {
      timer = setInterval(attempt, POLL_MS);
    }
  });
})();`;
}
