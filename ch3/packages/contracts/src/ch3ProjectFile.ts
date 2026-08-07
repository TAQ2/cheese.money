import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ProjectScriptIcon } from "./orchestration.ts";

/** File name of the checked-in CH3 project file, resolved at the workspace root. */
export const CH3_PROJECT_FILE_NAME = "ch3.json";

/** Public URL of the published JSON Schema for {@link CH3ProjectFile}. */
export const CH3_PROJECT_FILE_SCHEMA_URL = "https://ch3.codes/schema/ch3.json";

const CH3_PROJECT_FILE_PATH_MAX_LENGTH = 512;
const CH3_PROJECT_FILE_MAX_SCRIPTS = 50;

// Annotations go on the encoded (string) side so they survive into the
// published JSON Schema; decoding still trims and re-validates non-emptiness.
const trimmedNonEmpty = (annotations: { readonly description: string }, maxLength?: number) => {
  const annotated = Schema.String.annotate(annotations);
  const encoded =
    maxLength === undefined
      ? annotated.check(Schema.isNonEmpty())
      : annotated.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
};

export const CH3ProjectFileScript = Schema.Struct({
  name: trimmedNonEmpty({
    description: "Display name for the script, shown in the CH3 scripts menu.",
  }),
  command: trimmedNonEmpty({
    description: "Shell command executed in a CH3 terminal at the project root.",
  }),
  icon: Schema.optionalKey(
    ProjectScriptIcon.annotate({
      description: 'Icon shown next to the script in the scripts menu. Defaults to "play".',
    }),
  ),
  runOnWorktreeCreate: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs automatically after a worktree is created for a new thread.",
    }),
  ),
  previewUrl: Schema.optionalKey(
    trimmedNonEmpty({
      description:
        "URL opened in the in-app browser preview when this script runs. Only honored on the desktop build.",
    }),
  ),
  autoOpenPreview: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, automatically open the preview panel at `previewUrl` the moment the script starts.",
    }),
  ),
}).annotate({
  description: "A project script that team members can import into CH3.",
});
export type CH3ProjectFileScript = typeof CH3ProjectFileScript.Type;

export const CH3ProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: `URL of the JSON Schema for this file, typically "${CH3_PROJECT_FILE_SCHEMA_URL}".`,
    }),
  ),
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before CH3\'s built-in icon locations.',
      },
      CH3_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  scripts: Schema.optionalKey(
    Schema.Array(CH3ProjectFileScript)
      .annotate({
        description: "Project scripts shared with everyone who opens this repository in CH3.",
      })
      .check(Schema.isMaxLength(CH3_PROJECT_FILE_MAX_SCRIPTS)),
  ),
}).annotate({
  title: "CH3 project file",
  description:
    "Checked-in project configuration for CH3 (ch3.json at the repository root). See https://ch3.codes for documentation.",
});
export type CH3ProjectFile = typeof CH3ProjectFile.Type;
