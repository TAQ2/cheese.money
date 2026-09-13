import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/**
 * A relaunch the person asked for from the renderer.
 *
 * The other relaunches here are consequences of a settings change (server
 * exposure, WSL) and happen inside that change's own IPC. This one carries
 * no change: it exists for the moments the app tells the person "restart to
 * pick this up" — a skill just installed reaches a conversation only when
 * the provider instance is rebuilt — and a button beside that sentence beats
 * sending them to the menu. The reason lands in the lifecycle log as the
 * others do, prefixed so a renderer-initiated relaunch reads as one.
 */
export const relaunchApp = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RELAUNCH_APP_CHANNEL,
  payload: Schema.Struct({ reason: Schema.String }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.lifecycle.relaunchApp")(function* (input) {
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    yield* lifecycle.relaunch(`renderer:${input.reason.slice(0, 80)}`);
  }),
});
