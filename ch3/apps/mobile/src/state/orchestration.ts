import { createOrchestrationEnvironmentAtoms } from "@ch3tools/client-runtime/state/orchestration";

import { connectionAtomRuntime } from "../connection/runtime";

export const orchestrationEnvironment = createOrchestrationEnvironmentAtoms(connectionAtomRuntime);
