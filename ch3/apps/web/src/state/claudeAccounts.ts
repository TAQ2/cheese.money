import { createClaudeAccountEnvironmentAtoms } from "@ch3tools/client-runtime/state/claudeAccounts";

import { connectionAtomRuntime } from "../connection/runtime";

export const claudeAccountEnvironment = createClaudeAccountEnvironmentAtoms(connectionAtomRuntime);
