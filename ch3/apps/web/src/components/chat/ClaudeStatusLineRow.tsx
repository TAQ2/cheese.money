import { useMemo } from "react";
import type { ClaudeStatusLineContext, EnvironmentId } from "@ch3tools/contracts";

import { claudeStatusLineEnvironment } from "../../state/claudeStatusLine";
import { useEnvironmentQuery } from "../../state/query";
import { ClaudeStatusLine } from "./ClaudeStatusLine";

/**
 * Renders the user's configured Claude Code `statusLine` under the composer.
 *
 * Claude Code only runs this in its terminal UI, so a carefully built status
 * line is invisible in CH3. This asks the server to run the same command
 * with the same stdin contract and paints the result.
 */
export function ClaudeStatusLineRow({
  environmentId,
  cwd,
  modelDisplayName,
  version,
  contextWindowSize,
  contextRemainingPercentage,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly modelDisplayName?: string | undefined;
  readonly version?: string | undefined;
  readonly contextWindowSize?: number | null | undefined;
  readonly contextRemainingPercentage?: number | null | undefined;
}) {
  const input = useMemo((): ClaudeStatusLineContext | null => {
    if (cwd === null || cwd.length === 0) {
      return null;
    }
    // The atom family is keyed by this input, so anything that changes on every
    // token would churn atoms. Percentages are rounded because that is the
    // precision a status line displays anyway.
    return {
      cwd,
      ...(modelDisplayName === undefined ? {} : { modelDisplayName }),
      ...(version === undefined ? {} : { version }),
      ...(contextWindowSize === undefined || contextWindowSize === null
        ? {}
        : { contextWindowSize: Math.round(contextWindowSize) }),
      ...(contextRemainingPercentage === undefined || contextRemainingPercentage === null
        ? {}
        : { contextRemainingPercentage: Math.round(contextRemainingPercentage) }),
    };
  }, [cwd, modelDisplayName, version, contextWindowSize, contextRemainingPercentage]);

  const statusLineQuery = useEnvironmentQuery(
    input === null ? null : claudeStatusLineEnvironment.render({ environmentId, input }),
  );

  const text = statusLineQuery.data?.text ?? null;
  if (text === null || text.length === 0) {
    return null;
  }

  return (
    <div className="min-w-0 px-2.5 pt-1.5 sm:px-3">
      <ClaudeStatusLine text={text} />
    </div>
  );
}
