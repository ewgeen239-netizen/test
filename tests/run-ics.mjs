// Компилирует сборщик .ics и проверяет, что лента валидна.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
execFileSync("npx", ["--yes", "tsc", join(here, "..", "supabase", "functions", "durak", "ics.ts"),
  "--outDir", join(here, ".build", "ics"),
  "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler"], { stdio: "inherit" });
await import("./ics_feed.mjs");
