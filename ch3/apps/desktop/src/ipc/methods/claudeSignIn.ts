import { ClaudeSignInEmailHintPayload } from "@ch3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { rememberClaudeSignInEmail } from "../../window/claudeSignInEmailHint.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/**
 * Tell the main process which account the sign-in window about to open is for.
 *
 * The renderer holds the fact — it has the profile row the user clicked — and
 * the main process is the only side that can type into the sign-in page, which
 * is a third-party origin. The URL alone cannot say which of several signed-out
 * profiles this attempt belongs to, so the renderer states it here immediately
 * before `window.open`.
 *
 * `null` is not "no opinion", it is "this one is a brand-new account, prefill
 * nothing" — and it clears whatever a previous attempt left behind. Callers
 * send one or the other every time rather than skipping the call, so an
 * abandoned sign-in cannot bequeath its address to the next one.
 */
export const setClaudeSignInEmailHint = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLAUDE_SIGN_IN_EMAIL_HINT_CHANNEL,
  payload: ClaudeSignInEmailHintPayload,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.claudeSignIn.setEmailHint")(function* (payload) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    rememberClaudeSignInEmail(payload, nowMs);
  }),
});
