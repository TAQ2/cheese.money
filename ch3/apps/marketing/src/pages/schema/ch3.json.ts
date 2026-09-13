import type { APIRoute } from "astro";

import { buildCH3ProjectFileJsonSchema } from "@ch3tools/shared/ch3ProjectFile";

// Rendered at build time; published at https://ch3.codes/schema/ch3.json so
// ch3.json files can reference it via "$schema" for editor/LSP support.
//
// The shared module was renamed in the CH3 rebrand and this import was
// not, which made `astro check` — and with it the repo-wide typecheck CI
// stage — fail on a site CH3 does not ship. The route keeps its upstream
// path and file name: that is the URL ch3.json files out in the world point at.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildCH3ProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
