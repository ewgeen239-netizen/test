// Собирает функцию и гоняет её на стенде с подменёнными Deno, базой и Telegram.
// tsc ругается на глобальный Deno и на типы Uint8Array из dom-библиотеки —
// для прогона это неважно, код транспилируется; проверяем, что файл получился.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "supabase", "functions", "durak", "index.bundled.ts");
const out = join(here, ".build", "fn");
try {
  execFileSync("npx", ["--yes", "tsc", src, "--outDir", out,
    "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler"], { stdio: "pipe" });
} catch { /* только типы */ }
if (!existsSync(join(out, "index.bundled.js"))) {
  console.error("Не удалось собрать функцию");
  process.exit(1);
}
await import("./function_rooms.mjs");
