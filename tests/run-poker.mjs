// Компилирует движок холдема и гоняет по нему правила.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "supabase", "functions", "durak", "poker.ts");
execFileSync("npx", ["--yes", "tsc", src, "--outDir", join(here, ".build", "poker"),
  "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler"],
  { stdio: "inherit" });
await import("./poker_engine.mjs");
