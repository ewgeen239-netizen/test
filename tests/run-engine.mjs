// Компилирует движок в tests/.build и запускает по нему правила.
// Отдельный шаг нужен только потому, что движок написан на TypeScript
// (его читает Deno в Edge Function), а тесты гоняются обычным node.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "supabase", "functions", "durak", "engine.ts");

execFileSync("npx", ["--yes", "tsc", src, "--outDir", join(here, ".build"),
  "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler"],
  { stdio: "inherit" });

await import("./durak_engine.mjs");
