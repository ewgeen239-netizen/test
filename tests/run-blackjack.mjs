// Компилирует движок «двадцати одного» и гоняет по нему правила.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
execFileSync("npx", ["--yes", "tsc", join(here, "..", "supabase", "functions", "durak", "blackjack.ts"),
  "--outDir", join(here, ".build", "blackjack"),
  "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler"], { stdio: "inherit" });
await import("./blackjack_engine.mjs");
