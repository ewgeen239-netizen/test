// Готовит сборку функции и запускает браузерный прогон.
//
// tsc ругается на index.bundled.ts двумя вещами, которые для прогона не важны:
// глобальный Deno (его здесь подменяет стенд) и расхождение типов Uint8Array
// между dom-библиотекой tsc и типами Deno. Код при этом транспилируется, так
// что код возврата игнорируем и просто проверяем, что файл получился.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "supabase", "functions", "durak", "index.bundled.ts");
const out = join(here, ".build", "durak");

try {
  execFileSync("npx", ["--yes", "tsc", src, "--outDir", out,
    "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler"],
    { stdio: "pipe" });
} catch { /* только типы — код всё равно собран */ }

if (!existsSync(join(out, "index.bundled.js"))) {
  console.error("Не удалось собрать функцию — tsc не выдал index.bundled.js");
  process.exit(1);
}
await import("./app_cards.mjs");
