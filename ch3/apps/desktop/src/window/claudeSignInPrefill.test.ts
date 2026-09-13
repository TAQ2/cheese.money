import { assert, describe, it } from "@effect/vitest";

import {
  buildClaudeSignInPrefillScript,
  CLAUDE_SIGN_IN_EMAIL_SELECTORS,
  CLAUDE_SIGN_IN_PREFILL_HOSTS,
  isClaudeSignInPrefillUrl,
} from "./claudeSignInPrefill.ts";

/**
 * The script runs inside a third-party page, so the only honest test is to
 * RUN it. These fakes stand in for the parts of the DOM it touches; in
 * particular the value setter lives on the prototype, because reaching it
 * there is the whole mechanism the script depends on.
 */

class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  constructor(type: string, init: { readonly bubbles?: boolean } = {}) {
    this.type = type;
    this.bubbles = init.bubbles === true;
  }
}

class FakeInput {
  type = "email";
  disabled = false;
  readOnly = false;
  readonly events: Array<FakeEvent> = [];
  /** Every write that went through the PROTOTYPE setter, in order. */
  readonly prototypeWrites: Array<string> = [];
  /**
   * Every write that went through the node's OWN setter — React's value
   * tracker. An empty array is the assertion that matters: the script must
   * BYPASS this, because a write React's tracker observes is one React
   * concludes changed nothing.
   */
  readonly trackedWrites: Array<string> = [];
  private stored = "";

  constructor(init: Partial<Pick<FakeInput, "type" | "disabled" | "readOnly">> = {}) {
    Object.assign(this, init);
    installReactValueTracker(this);
  }

  get value(): string {
    return this.stored;
  }

  set value(next: string) {
    this.prototypeWrites.push(next);
    this.stored = next;
  }

  dispatchEvent(event: FakeEvent): boolean {
    this.events.push(event);
    return true;
  }
}

/**
 * Reproduce what React installs on a controlled input.
 *
 * React's `inputValueTracking` defines an OWN `value` accessor on the node
 * that shadows the prototype's and records the last value it saw. A plain
 * `node.value = x` lands on this shadow, so React's record matches and React
 * concludes the field did not change — the box shows the text, React's next
 * render restores the old value, and the form submits blank. Reaching the
 * PROTOTYPE setter goes around the shadow, leaving React's record stale, which
 * is what makes React accept the following `input` event.
 *
 * Without this shadow both routes collapse onto the same setter and a test
 * cannot tell the mechanism from its absence.
 */
function installReactValueTracker(node: FakeInput): void {
  const prototypeDescriptor = Object.getOwnPropertyDescriptor(FakeInput.prototype, "value");
  const get = prototypeDescriptor?.get;
  const set = prototypeDescriptor?.set;
  if (!get || !set) throw new Error("FakeInput must define `value` on its prototype");
  Object.defineProperty(node, "value", {
    configurable: true,
    enumerable: false,
    get(this: FakeInput) {
      return get.call(this) as string;
    },
    set(this: FakeInput, next: string) {
      this.trackedWrites.push(next);
      set.call(this, next);
    },
  });
}

interface RunOptions {
  readonly email: string;
  readonly hostname?: string;
  /** selector → element, consulted in the script's own priority order. */
  readonly matches?: Readonly<Record<string, FakeInput>>;
  /** Return nothing for this many querySelector sweeps, to mimic a late mount. */
  readonly appearAfterSweeps?: number;
  readonly deadlineMs?: number;
  readonly pollMs?: number;
  readonly windowState?: Record<string, unknown>;
}

async function runPrefillScript(options: RunOptions): Promise<{
  readonly filled: unknown;
  readonly window: Record<string, unknown>;
  readonly selectorsTried: ReadonlyArray<string>;
}> {
  const script = buildClaudeSignInPrefillScript({
    email: options.email,
    deadlineMs: options.deadlineMs ?? 200,
    pollMs: options.pollMs ?? 5,
  });
  const windowState = options.windowState ?? {};
  const selectorsTried: Array<string> = [];
  let sweeps = 0;
  const matches = options.matches ?? {};
  const fakeDocument = {
    querySelector(selector: string): FakeInput | null {
      selectorsTried.push(selector);
      // One "sweep" is one pass over the selector list.
      if (selector === CLAUDE_SIGN_IN_EMAIL_SELECTORS[0]) sweeps += 1;
      if (options.appearAfterSweeps !== undefined && sweeps <= options.appearAfterSweeps) {
        return null;
      }
      return matches[selector] ?? null;
    },
  };
  // `return`, because the built source is an expression statement: without it
  // the function body would evaluate the IIFE and discard its promise.
  const run = new Function(
    "window",
    "location",
    "document",
    "HTMLInputElement",
    "Event",
    `return ${script}`,
  ) as (
    window: Record<string, unknown>,
    location: { hostname: string },
    document: unknown,
    htmlInputElement: unknown,
    event: unknown,
  ) => Promise<unknown>;

  const filled = await run(
    windowState,
    { hostname: options.hostname ?? "claude.ai" },
    fakeDocument,
    FakeInput,
    FakeEvent,
  );
  return { filled, window: windowState, selectorsTried };
}

describe("buildClaudeSignInPrefillScript", () => {
  it("types the address into an empty box through the prototype setter", async () => {
    const input = new FakeInput();
    const { filled, window } = await runPrefillScript({
      email: "someone@example.com",
      matches: { 'input[type="email"]': input },
    });

    assert.strictEqual(filled, true);
    assert.strictEqual(input.value, "someone@example.com");
    // The crux, and the pair of assertions is what makes it a real test. The
    // write must reach the PROTOTYPE setter and must NOT be seen by React's
    // own-property tracker — a write the tracker observes is one React
    // concludes changed nothing, so its next render restores the empty value
    // and the form submits blank. Replacing the script's
    // `getOwnPropertyDescriptor` dance with `input.value = EMAIL` flips
    // trackedWrites to non-empty and fails here.
    assert.deepStrictEqual(input.prototypeWrites, ["someone@example.com"]);
    assert.deepStrictEqual(input.trackedWrites, []);
    assert.deepStrictEqual(
      input.events.map((event) => [event.type, event.bubbles]),
      [
        ["input", true],
        ["change", true],
      ],
    );
    // The run leaves no lock behind for the next navigation's injection.
    assert.strictEqual(window["__ch3ClaudeEmailPrefillRunning"], false);
  });

  it("never overwrites something the user has already typed", async () => {
    const input = new FakeInput();
    input.value = "half-typed@elsewhere.com";
    input.prototypeWrites.length = 0;

    const { filled } = await runPrefillScript({
      email: "someone@example.com",
      matches: { 'input[type="email"]': input },
    });

    // Reported as handled — the box has an address in it — but the user's
    // keystrokes outrank our guess, so nothing was written or dispatched.
    assert.strictEqual(filled, true);
    assert.strictEqual(input.value, "half-typed@elsewhere.com");
    assert.deepStrictEqual(input.prototypeWrites, []);
    assert.deepStrictEqual(input.events, []);
  });

  it("refuses to type into a page that is not the sign-in", async () => {
    const input = new FakeInput();
    const { filled } = await runPrefillScript({
      email: "someone@example.com",
      hostname: "evil.example",
      matches: { 'input[type="email"]': input },
    });

    assert.strictEqual(filled, false);
    assert.strictEqual(input.value, "");
    assert.deepStrictEqual(input.events, []);
  });

  it("waits for a field that mounts after the page loads", async () => {
    // The sign-in is a single-page app: the box is almost never present at
    // first paint, which is why one shot at load is not enough.
    const input = new FakeInput();
    const { filled } = await runPrefillScript({
      email: "someone@example.com",
      matches: { 'input[type="email"]': input },
      appearAfterSweeps: 3,
    });

    assert.strictEqual(filled, true);
    assert.strictEqual(input.value, "someone@example.com");
  });

  it("gives up at the deadline instead of polling forever", async () => {
    const { filled, window } = await runPrefillScript({
      email: "someone@example.com",
      matches: {},
      deadlineMs: 40,
      pollMs: 5,
    });

    assert.strictEqual(filled, false);
    assert.strictEqual(window["__ch3ClaudeEmailPrefillRunning"], false);
  });

  it("stands down when another injection is already running", async () => {
    // The handler re-injects on every load; without the guard those pile up
    // into several timers racing to fill the same box.
    const { filled } = await runPrefillScript({
      email: "someone@example.com",
      matches: { 'input[type="email"]': new FakeInput() },
      windowState: { __ch3ClaudeEmailPrefillRunning: true },
    });
    assert.strictEqual(filled, false);
  });

  it("skips candidates that cannot be typed into", async () => {
    const disabled = new FakeInput({ disabled: true });
    const readOnly = new FakeInput({ readOnly: true });
    const hidden = new FakeInput({ type: "hidden" });
    const real = new FakeInput({ type: "text" });

    const { filled } = await runPrefillScript({
      email: "someone@example.com",
      matches: {
        'input[type="email"]': disabled,
        'input[name="email"]': readOnly,
        'input[autocomplete="email"]': hidden,
        'input[inputmode="email"]': real,
      },
    });

    assert.strictEqual(filled, true);
    assert.strictEqual(real.value, "someone@example.com");
    for (const skipped of [disabled, readOnly, hidden]) {
      assert.strictEqual(skipped.value, "");
    }
  });

  it("prefers the semantic email field over one merely named like it", async () => {
    const semantic = new FakeInput();
    const byPlaceholder = new FakeInput({ type: "text" });
    const { filled } = await runPrefillScript({
      email: "someone@example.com",
      matches: {
        'input[type="email"]': semantic,
        'input[placeholder*="email" i]': byPlaceholder,
      },
    });

    assert.strictEqual(filled, true);
    assert.strictEqual(semantic.value, "someone@example.com");
    assert.strictEqual(byPlaceholder.value, "");
  });

  it("carries an address containing quotes without breaking out of the literal", async () => {
    // The value comes from a file on disk CH3 did not write, so it reaches
    // the script as data or it is an injection hole.
    const hostile = `"+alert(1)+"\\'@example.com`;
    const input = new FakeInput();
    const { filled } = await runPrefillScript({
      email: hostile,
      matches: { 'input[type="email"]': input },
    });

    assert.strictEqual(filled, true);
    assert.strictEqual(input.value, hostile);
  });

  it("gates on the URL outside the page, where the page cannot reach it", () => {
    // This is the real boundary. The in-page check runs on the page's own
    // location and Array.prototype, so a hostile page can defeat it; this one
    // reads the URL Electron reports.
    assert.isTrue(isClaudeSignInPrefillUrl("https://claude.ai/oauth/authorize?code=true"));
    assert.isTrue(isClaudeSignInPrefillUrl("https://claude.com/cai/oauth/authorize"));
    // An identity provider the flow can be steered to must never receive it.
    assert.isFalse(isClaudeSignInPrefillUrl("https://accounts.google.com/o/oauth2/auth"));
    // Nor the CLI's own loopback callback, which is where the flow ends.
    assert.isFalse(isClaudeSignInPrefillUrl("http://localhost:64503/callback"));
    // Subdomains are excluded deliberately: a suffix match would hand the
    // address to anything under the domain a redirect could reach.
    assert.isFalse(isClaudeSignInPrefillUrl("https://www.claude.ai/oauth"));
    assert.isFalse(isClaudeSignInPrefillUrl("https://evil.claude.ai.example/oauth"));
    assert.isFalse(isClaudeSignInPrefillUrl("http://claude.ai/oauth"));
    assert.isFalse(isClaudeSignInPrefillUrl("not a url"));
  });

  it("keeps the host allow-list and the selector list non-empty", () => {
    // Losing either silently turns the feature into a no-op rather than a
    // failure, so they are asserted rather than assumed.
    assert.isAbove(CLAUDE_SIGN_IN_PREFILL_HOSTS.length, 0);
    assert.isAbove(CLAUDE_SIGN_IN_EMAIL_SELECTORS.length, 1);
    assert.include([...CLAUDE_SIGN_IN_PREFILL_HOSTS], "claude.ai");
    assert.include([...CLAUDE_SIGN_IN_PREFILL_HOSTS], "claude.com");
  });
});
