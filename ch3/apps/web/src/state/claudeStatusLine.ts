import { createClaudeStatusLineEnvironmentAtoms } from "@ch3tools/client-runtime/state/claudeStatusLine";

import { connectionAtomRuntime } from "../connection/runtime";

export const claudeStatusLineEnvironment =
  createClaudeStatusLineEnvironmentAtoms(connectionAtomRuntime);
