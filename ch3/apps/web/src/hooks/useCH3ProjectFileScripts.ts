import {
  CH3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type CH3ProjectFileScript,
} from "@ch3tools/contracts";
import { CH3ProjectFileFromJson } from "@ch3tools/shared/ch3ProjectFile";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const decodeCH3ProjectFile = Schema.decodeExit(CH3ProjectFileFromJson);

const NO_SCRIPTS: ReadonlyArray<CH3ProjectFileScript> = [];

/**
 * Scripts declared in the project's checked-in `ch3.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useCH3ProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<CH3ProjectFileScript> {
  const query = useProjectFileQuery(environmentId, cwd ?? "", CH3_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  return useMemo(() => {
    if (contents === null) return NO_SCRIPTS;
    const decoded = decodeCH3ProjectFile(contents);
    if (Exit.isFailure(decoded)) return NO_SCRIPTS;
    return decoded.value.scripts ?? NO_SCRIPTS;
  }, [contents]);
}
