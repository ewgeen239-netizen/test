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
//  Столы для карточных игр — ОДНОФАЙЛОВАЯ СБОРКА для редактора Supabase.
//
//  Собрано скриптом bundle.py из engine.ts («дурак»), poker.ts (холдем),
//  blackjack.ts («21»), domino.ts и index.ts. Правь оригиналы, а не этот файл: он
//  перегенерируется и правки потеряются. При деплое через CLI бери обычный
//  index.ts — он подтянет соседние модули сам.
// ═══════════════════════════════════════════════════════════════════

"""

MODULES = ["engine.ts", "poker.ts", "blackjack.ts", "domino.ts", "sea.ts", "ics.ts"]        # порядок = порядок в сборке

parts = []
index = (HERE / "index.ts").read_text(encoding="utf-8")
for mod in MODULES:
    src = (HERE / mod).read_text(encoding="utf-8").strip()
    parts.append(src)
    # импорт модуля выкидываем — его код теперь прямо над index.ts
    index, n = re.subn(r'^import [\s\S]*?from "\./' + mod.replace(".", r"\.") + r'";\n', "", index, flags=re.M)
    if n != 1:
        raise SystemExit(f"не нашёл импорт {mod} в index.ts — проверь файл")

# Проверка на совпадающие имена: в сборке все движки лежат на одном уровне,
# и одинаковое имя молча превратится в вызов чужой функции.
def tops(src):
    return set(m.group(1) for m in re.finditer(
        r"^(?:export\s+)?(?:const|let|function|type|class)\s+([A-Za-z_$][\w$]*)", src, re.M))
seen = {}
for mod, src in zip(MODULES, parts):
    for name in tops(src):
        if name in seen:
            raise SystemExit(f"имя {name} объявлено и в {seen[name]}, и в {mod} — переименуй")
        seen[name] = mod

out = HEAD + "\n\n\n".join(parts) + "\n\n\n" + index.strip() + "\n"
(HERE / "index.bundled.ts").write_text(out, encoding="utf-8")
print(f"index.bundled.ts собран: {len(out.splitlines())} строк")
