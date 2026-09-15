#!/usr/bin/env python3
"""Собирает index.bundled.ts из engine.ts + index.ts.

Нужен только для деплоя через Dashboard: в редакторе Supabase удобнее один
файл, а обычный index.ts тянет соседний engine.ts импортом, которого там нет.
CLI бандл не нужен — он забирает всю папку целиком.

Запуск:  python3 supabase/functions/durak/bundle.py
"""
import pathlib
import re

HERE = pathlib.Path(__file__).parent
HEAD = """\
// ═══════════════════════════════════════════════════════════════════
//  durak — ОДНОФАЙЛОВАЯ СБОРКА для вставки в редактор Supabase.
//
//  Собрано из engine.ts + index.ts скриптом bundle.py. Правь оригиналы,
//  а не этот файл: он перегенерируется и правки потеряются. При деплое
//  через CLI бери обычный index.ts — он подтянет engine.ts сам.
// ═══════════════════════════════════════════════════════════════════

"""

engine = (HERE / "engine.ts").read_text(encoding="utf-8").strip()
index = (HERE / "index.ts").read_text(encoding="utf-8")

# выкидываем импорт движка — движок теперь прямо над этим кодом
index, n = re.subn(r'^import .*? from "\./engine\.ts";\n', "", index, flags=re.M)
if n != 1:
    raise SystemExit("не нашёл импорт engine.ts в index.ts — проверь файл")

out = HEAD + engine + "\n\n\n" + index.strip() + "\n"
(HERE / "index.bundled.ts").write_text(out, encoding="utf-8")
print(f"index.bundled.ts собран: {len(out.splitlines())} строк")
