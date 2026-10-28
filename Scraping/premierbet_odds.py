"""Odds reais da Premier Bet por mercado — SÓ API (sem browser).

Entrada (argv[1] ou stdin): JSON
  {
    "legs": [
      {"home": "Equipa A", "away": "Equipa B",
       "kickoffAt": 1770000000000,
       "date": "2026-10-28",              # opcional (YYYY-MM-DD)
       "markets": ["over35", "double_chance_1x", ...]}
    ]
  }

Saída JSON:
  {"ok": true, "results": [
    {"home": ..., "away": ..., "event_id": "...", "event": "A v B",
     "odds": {"over35": 2.35, "double_chance_1x": null, ...}}
  ]}

Serve para dar preço real aos mercados que o feed do AiScore não traz
(DC, over/under 1.5/3.5, DNB) antes de montar uma ficha. Nunca inventa odds:
o que não existir no evento volta null.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from premierbet_book import MARKET_MAP, PBClient, find_event, pick_outcome  # noqa: E402

MARKETS = list(MARKET_MAP.keys())


def _ymd(leg: dict) -> str:
    ds = str(leg.get("date") or "")
    if len(ds) == 10 and ds[4] == "-":
        return ds
    if len(ds) == 10 and ds[2] in "/." and ds[5] in "/.":
        d, m, y = ds.replace(".", "/").split("/")
        return f"{y}-{m.zfill(2)}-{d.zfill(2)}"
    ts = leg.get("kickoffAt")
    if ts:
        dt = datetime.fromtimestamp(int(ts) / 1000, tz=timezone.utc)
        return (dt + timedelta(hours=1)).strftime("%Y-%m-%d")  # AO = UTC+1
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def main() -> int:
    raw = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"invalid JSON: {exc}"}))
        return 0

    legs = payload.get("legs") or []
    if not isinstance(legs, list) or not legs:
        print(json.dumps({"ok": False, "error": "legs required"}))
        return 0

    client = PBClient()
    results = []
    for leg in legs:
        home = str(leg.get("home") or "").strip()
        away = str(leg.get("away") or "").strip()
        wanted = [m for m in (leg.get("markets") or MARKETS) if m in MARKETS]
        entry = {"home": home, "away": away, "event_id": None,
                 "event": None, "odds": {m: None for m in wanted},
                 "error": None}
        if not home or not away:
            entry["error"] = "home/away required"
            results.append(entry)
            continue

        base = _ymd(leg)
        dates = [base]
        try:
            base_dt = datetime.strptime(base, "%Y-%m-%d")
            dates += [
                (base_dt - timedelta(days=1)).strftime("%Y-%m-%d"),
                (base_dt + timedelta(days=1)).strftime("%Y-%m-%d"),
            ]
        except ValueError:
            pass

        ev = None
        try:
            for date_ymd in dates:
                ev = find_event(client, home, away, date_ymd,
                                kickoff_ms=leg.get("kickoffAt"))
                if ev:
                    break
        except Exception as exc:  # rede/API
            entry["error"] = f"api: {exc}"
            results.append(entry)
            continue
        if not ev:
            entry["error"] = "jogo não localizado na Premier Bet"
            results.append(entry)
            continue

        try:
            detail = client.event(ev["id"])
        except Exception as exc:
            entry["error"] = f"event: {exc}"
            results.append(entry)
            continue

        entry["event_id"] = ev["id"]
        entry["event"] = f"{ev['home']} v {ev['away']}"
        entry["match_score"] = ev.get("match_score")
        for market in wanted:
            try:
                pick = pick_outcome(detail, market)
                if pick:
                    entry["odds"][market] = float(pick["outcome"].get("value"))
            except Exception:
                entry["odds"][market] = None
        results.append(entry)

    print(json.dumps({"ok": True, "results": results}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
