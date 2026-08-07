import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@ch3tools/marketing...'",
  buildCommand: "vp run --filter @ch3tools/marketing build",
  outputDirectory: "dist",
};
