#!/usr/bin/env python3
"""Repara mojibake UTF-8 -> cp1252 linha-a-linha.

O ficheiro alvo esta em UTF-8, mas algumas linhas contem o resultado de os
bytes UTF-8 originais terem sido interpretados como cp1252 (ex.: "Ã£" em vez
de "ã"). A reparacao e feita por linha: encode("cp1252").decode("utf-8").
Linhas que nao sobrevivem ao round-trip ficam intactas e sao listadas para
revisao manual.

Uso:
  python scripts/fix_mojibake.py --dry-run server src server.ts README.md
  python scripts/fix_mojibake.py server src server.ts README.md
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys

# "NÃO" e português legítimo usam "Ã" seguido de ASCII; o mojibake usa
# "Ã"/"Â"/"â" seguidos de um caractere não-ASCII (ex.: "Ã£", "Ã©", "Âº", "âœ“").
MARKERS = re.compile(r"Ã[^\x00-\x7F]|Â[^\x00-\x7F]|â[^\x00-\x7F]|\ufffd")
TEXT_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".css", ".html", ".py"}

# Mapa inverso do cp1252. Inclui os C1 controls (U+0080..U+009F) para
# decodificarmos bytes que o cp1252 deixa indefinidos (ex.: 0x9D).
_CP1252_INVERSE = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84,
    0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88,
    0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C,
    0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93,
    0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B,
    0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F,
}


def encode_cp1252(text: str) -> bytes:
    out = bytearray()
    for ch in text:
        code = ord(ch)
        if code <= 0xFF:
            out.append(code)
        elif code in _CP1252_INVERSE:
            out.append(_CP1252_INVERSE[code])
        else:
            raise UnicodeEncodeError("cp1252", text, 0, len(text), "unmapped")
    return bytes(out)


def iter_files(paths: list[str]) -> list[pathlib.Path]:
    out: list[pathlib.Path] = []
    for raw in paths:
        p = pathlib.Path(raw)
        if p.is_dir():
            out.extend(
                f for f in p.rglob("*") if f.is_file() and f.suffix in TEXT_SUFFIXES
            )
        elif p.is_file():
            out.append(p)
    return out


def _roundtrip(line: str) -> str | None:
    try:
        return encode_cp1252(line).decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return None


def _repair_segments(line: str) -> str:
    """Repara apenas os troços mojibake de uma linha que mistura texto bom."""
    chars = list(line)
    out: list[str] = []
    i = 0
    while i < len(chars):
        best: str | None = None
        best_len = 0
        if chars[i] in "ÃÂâ" or chars[i] == "\ufffd":
            for length in range(min(12, len(chars) - i), 1, -1):
                segment = "".join(chars[i : i + length])
                fixed = _roundtrip(segment)
                if fixed is None:
                    continue
                if len(MARKERS.findall(fixed)) < len(MARKERS.findall(segment)):
                    best = fixed
                    best_len = length
                    break
        if best is not None:
            out.append(best)
            i += best_len
        else:
            out.append(chars[i])
            i += 1
    return "".join(out)


def repair_line(line: str) -> tuple[str, bool]:
    current = line
    before = len(MARKERS.findall(current))
    if before == 0:
        return line, True
    # Alguns blocos (README) foram codificados duas vezes ("ÃƒÂ¡"); repetir o
    # round-trip enquanto houver ganho de marcadores. Quando a linha mistura
    # texto correto com mojibake, a reparação é feita por troços.
    for _ in range(5):
        changed = False
        fixed = _roundtrip(current)
        if fixed is not None:
            after = len(MARKERS.findall(fixed))
            if after < before:
                current, before, changed = fixed, after, True
        if before > 0:
            fixed = _repair_segments(current)
            after = len(MARKERS.findall(fixed))
            if after < before:
                current, before, changed = fixed, after, True
        if before == 0 or not changed:
            break
    return current, before == 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    files = iter_files(args.paths)
    total_fixed = 0
    total_residual = 0
    for path in files:
        raw = path.read_bytes()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as err:
            print(f"[SKIP] {path}: nao e UTF-8 valido ({err})")
            continue
        out: list[str] = []
        fixed_lines = 0
        residual: list[int] = []
        for number, line in enumerate(text.splitlines(keepends=True), 1):
            fixed, clean = repair_line(line)
            if fixed != line:
                fixed_lines += 1
            if MARKERS.search(fixed):
                residual.append(number)
            out.append(fixed)
        if fixed_lines:
            total_fixed += fixed_lines
            if not args.dry_run:
                path.write_bytes("".join(out).encode("utf-8"))
            print(f"{'[DRY]' if args.dry_run else '[FIX]'} {path}: {fixed_lines} linha(s)")
        if residual:
            total_residual += len(residual)
            print(f"  [REVER A MAO] {path}: linhas {residual}")
    print(
        f"\nTotal: {total_fixed} linha(s) reparada(s); "
        f"{total_residual} linha(s) ainda com marcadores."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
