import { createOpenCodeUsageMetricsEnvironmentAtoms } from "@ch3tools/client-runtime/state/opencodeUsageMetrics";

import { connectionAtomRuntime } from "../connection/runtime";

export const opencodeUsageMetricsEnvironment =
  createOpenCodeUsageMetricsEnvironmentAtoms(connectionAtomRuntime);
