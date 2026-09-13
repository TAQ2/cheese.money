import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopAgentPowerGuard from "../../power/DesktopAgentPowerGuard.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const AgentActivityInput = Schema.Struct({
  active: Schema.Boolean,
});

export const setAgentActivity = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_AGENT_ACTIVITY_CHANNEL,
  payload: AgentActivityInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.power.setAgentActivity")(function* ({ active }) {
    const guard = yield* DesktopAgentPowerGuard.DesktopAgentPowerGuard;
    yield* guard.setActive(active);
  }),
});
