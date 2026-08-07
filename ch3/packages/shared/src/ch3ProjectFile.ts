import * as Schema from "effect/Schema";

import { CH3ProjectFile, CH3_PROJECT_FILE_SCHEMA_URL } from "@ch3tools/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `ch3.json` file contents (lenient JSONC string) and the
 * decoded {@link CH3ProjectFile}.
 */
export const CH3ProjectFileFromJson = fromLenientJson(CH3ProjectFile);

/**
 * Build the publishable JSON Schema document for `ch3.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link CH3_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildCH3ProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(CH3ProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: CH3_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
