import type { APIRoute } from "astro";

import { buildCH3ProjectFileJsonSchema } from "@ch3tools/shared/ch3ProjectFile";

// Rendered at build time; published at https://ch3.codes/schema/ch3.json so
// ch3.json files can reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildCH3ProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
