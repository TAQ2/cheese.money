import { useMemo } from "react";
import type { EnvironmentId, OpenCodeUsageMetricsContext } from "@ch3tools/contracts";

import { opencodeUsageMetricsEnvironment } from "../../state/opencodeUsageMetrics";
import { useEnvironmentQuery } from "../../state/query";
import { ClaudeStatusLine } from "./ClaudeStatusLine";

/**
 * Renders the OpenCode provider's configured usage-metrics command under the
 * composer.
 *
 * This is NOT the Claude status line with a different gate. Claude Code has a
 * `statusLine` hook and CH3 mirrors it so an existing script keeps working;
 * OpenCode has no such hook, and the plan data behind Claude's meters — the
 * session and weekly rate-limit windows — has no equivalent on a flat-rate
 * provider like Maple. So this reports what an OpenCode user can actually
 * measure: spend against a billing cycle, burn rate, cache efficiency.
 *
 * `ClaudeStatusLine` is reused deliberately: despite the name it is a plain
 * ANSI-to-DOM renderer, and a second copy of an escape-sequence parser is a
 * worse outcome than a name that reads oddly here.
 */
export function OpenCodeUsageMetricsRow({
  environmentId,
  cwd,
  modelDisplayName,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly modelDisplayName?: string | undefined;
}) {
  const input = useMemo((): OpenCodeUsageMetricsContext | null => {
    if (cwd === null || cwd.length === 0) {
      return null;
    }
    // The atom family is keyed by this input, so anything that changes on every
    // token would churn atoms. Nothing per-token belongs in here.
    return {
      cwd,
      ...(modelDisplayName === undefined ? {} : { modelDisplayName }),
    };
  }, [cwd, modelDisplayName]);

  const usageQuery = useEnvironmentQuery(
    input === null ? null : opencodeUsageMetricsEnvironment.render({ environmentId, input }),
  );

  const text = usageQuery.data?.text ?? null;
  if (text === null || text.length === 0) {
    return null;
  }

  return (
    <div className="min-w-0 px-2.5 pt-1.5 sm:px-3">
      <ClaudeStatusLine text={text} />
    </div>
  );
}
