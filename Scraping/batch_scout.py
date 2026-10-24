"""Batch scout collector — one JSON payload per match (forms/H2H/trends/market hints).

Usage (Python 3.12 venv, UTF-8):
  .\\.venv312\\Scripts\\python.exe -X utf8 batch_scout.py                      # demo: j374oi04xwnhgqo
  .\\.venv312\\Scripts\\python.exe -X utf8 batch_scout.py --date 20260924      # all football ids that day
  .\\.venv312\\Scripts\\python.exe -X utf8 batch_scout.py --date 20260924 --upcoming --limit 20
  .\\.venv312\\Scripts\\python.exe -X utf8 batch_scout.py --matches id1,id2

Output:
  scout/<match_id>.json          per-match scouting payload
  scout_report_<date>.json       combined report (date = --date or today YYYYMMDD)

--date decode: GET /v1/web/api/matches?date=YYYYMMDD -> Response.data decoded as
protobuf message `Matches` (v1.Matches):
  field 2  matches     repeated Match      (Match.team/competition submessages carry ONLY ids)
  field 2  teams       repeated Team       (id+name map -> resolve team names)
  field 1  competitions repeated Competition (id+name map -> resolve comp names)
  field 15 Match.matchTime (unix) -> kickoff; sportId 1 = football.

Meta without --date comes from match/data (WebMatchData.match: kickoff, team
names, competition name). One AiscoreClient is shared so the built-in 1.6s
throttle applies across every call. Per-match failures are logged and skipped.
"""
from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

from aiscore_client import AiscoreClient, decode_packed_sint32
from schema_decode import decode_response, get

TZ = timezone(timedelta(hours=-3))  # client default tz=-03:00
DEMO_MATCH_ID = "j374oi04xwnhgqo"
OUT_DIR = Path("scout")


def kickoff_str(ts) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(int(ts), tz=TZ).strftime("%Y-%m-%d %H:%M")


def _json_default(o):
    if isinstance(o, (bytes, bytearray)):
        return o.decode("utf-8", "replace")
    return str(o)


def _side(sub, key_id, key_name):
    if not isinstance(sub, list):
        return {"id": None, "name": None}
    return {"id": get(sub, key_id), "name": get(sub, key_name)}


def matches_for_date(c: AiscoreClient, date: str, upcoming_only: bool = False) -> list[dict]:
    """Decode matches?date= (message `Matches`) into per-match meta dicts."""
    msg = decode_response(c.matches(date), "Matches")
    if not isinstance(msg, list):
        raise RuntimeError(f"matches?date={date}: could not decode message 'Matches'")
    tmap = {get(v, "id"): get(v, "name")
            for _, n, _, v in msg if n == "teams" and isinstance(v, list)}
    cmap = {get(v, "id"): get(v, "name")
            for _, n, _, v in msg if n == "competitions" and isinstance(v, list)}
    out = []
    for _, n, _, r in msg:
        if n != "matches" or not isinstance(r, list):
            continue
        if get(r, "sportId") not in (None, 1):
            continue
        status = get(r, "statusId")
        if upcoming_only and status != 1:
            continue
        home = _side(get(r, "homeTeam"), "id", "name")
        away = _side(get(r, "awayTeam"), "id", "name")
        comp = get(r, "competition")
        cid = get(comp, "id") if isinstance(comp, list) else None
        cname = (get(comp, "name") if isinstance(comp, list) and get(comp, "name")
                 else cmap.get(cid) or cid)
        home["name"] = home["name"] or tmap.get(home["id"]) or home["id"]
        away["name"] = away["name"] or tmap.get(away["id"]) or away["id"]
        mid = get(r, "id")
        if not mid:
            continue

        # Placar ja vem no day card (homeScores/awayScores empacotados em
        # sint32 zigzag: [FT, 1H, 2H, ET1, ET2, Penaltis]). Permite validar
        # TODOS os jogos do dia com uma unica chamada a matches?date=.
        raw_h = get(r, "homeScores")
        raw_a = get(r, "awayScores")
        ph = decode_packed_sint32(raw_h) if isinstance(raw_h, (bytes, bytearray)) else []
        pa = decode_packed_sint32(raw_a) if isinstance(raw_a, (bytes, bytearray)) else []
        mstatus = get(r, "matchStatus")
        ft_home = ph[0] if ph else None
        ft_away = pa[0] if pa else None
        ht_home = ph[1] if len(ph) > 1 else None
        ht_away = pa[1] if len(pa) > 1 else None
        finished = status == 8 or mstatus == 3

        out.append({
            "match_id": mid,
            "kickoff": kickoff_str(get(r, "matchTime")),
            "home": home,
            "away": away,
            "competition": cname,
            "competition_id": cid,
            "statusId": status,
            "matchStatus": mstatus,
            "finished": finished,
            "ft_home": ft_home,
            "ft_away": ft_away,
            "ht_home": ht_home,
            "ht_away": ht_away,
        })
    out.sort(key=lambda x: x["kickoff"] or "")
    return out


def meta_from_match_data(c: AiscoreClient, match_id: str) -> dict:
    """Meta (kickoff/teams/competition) from GET match/data -> WebMatchData."""
    wmd = c.match_data(match_id)
    m = get(wmd, "match")
    if not isinstance(m, list):
        raise RuntimeError(f"match/data returned no match for {match_id}")
    comp = get(m, "competition")
    cname = get(comp, "name") if isinstance(comp, list) else None
    cid = get(comp, "id") if isinstance(comp, list) else None
    return {
        "match_id": get(m, "id") or match_id,
        "kickoff": kickoff_str(get(m, "matchTime")),
        "home": _side(get(m, "homeTeam"), "id", "name"),
        "away": _side(get(m, "awayTeam"), "id", "name"),
        "competition": cname or cid,
        "competition_id": cid,
        "statusId": get(m, "statusId"),
    }


def side_hints(form: dict, side: str) -> dict:
    """market hints from one side's form.matches (finished FT rows only)."""
    rows = [r for r in (form.get("matches") or [])
            if r and r.get("finished")
            and r.get("ft_home") is not None and r.get("ft_away") is not None]
    keys = (f"avg_total_{side}_last10", f"over25_{side}_rate", f"btts_{side}_rate")
    if not rows:
        return dict.fromkeys(keys)
    totals = [r["ft_home"] + r["ft_away"] for r in rows]
    n = len(rows)
    return {
        keys[0]: round(sum(totals) / n, 2),
        keys[1]: round(sum(1 for t in totals if t > 2.5) / n, 3),
        keys[2]: round(sum(1 for r in rows if r["ft_home"] > 0 and r["ft_away"] > 0) / n, 3),
    }


def scout_one(c: AiscoreClient, match_id: str, meta: dict | None = None) -> dict:
    if meta is None:
        meta = meta_from_match_data(c, match_id)
    hist = c.match_history_parsed(match_id)
    if hist.get("error") or "home_form" not in hist:
        raise RuntimeError(f"match/history parse failed: {hist.get('error') or 'missing keys'}")
    hf = hist.get("home_form") or {}
    af = hist.get("away_form") or {}
    mh = meta.get("home") or {}
    ma = meta.get("away") or {}
    return {
        "match_id": match_id,
        "kickoff": meta.get("kickoff"),
        "home": {"id": mh.get("id") or hist.get("home_team_id"),
                 "name": mh.get("name") or hist.get("home_team")},
        "away": {"id": ma.get("id") or hist.get("away_team_id"),
                 "name": ma.get("name") or hist.get("away_team")},
        "competition": meta.get("competition"),
        "competition_id": meta.get("competition_id"),
        "home_form": hf,
        "away_form": af,
        "h2h": hist.get("h2h") or [],
        "h2h_summary": hist.get("h2h_summary"),
        "home_trend": hist.get("home_trend"),
        "away_trend": hist.get("away_trend"),
        "home_trend_sc": hist.get("home_trend_sc"),
        "away_trend_sc": hist.get("away_trend_sc"),
        "market_hints": {**side_hints(hf, "home"), **side_hints(af, "away")},
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Batch scout collector (aiscore)")
    ap.add_argument("--date", help="YYYYMMDD — pull that day's football match ids")
    ap.add_argument("--matches", help="comma-separated match ids")
    ap.add_argument("--upcoming", action="store_true",
                    help="with --date: only statusId=1 (not started)")
    ap.add_argument("--limit", type=int, default=0,
                    help="cap number of matches (0 = no cap)")
    args = ap.parse_args(argv)

    c = AiscoreClient()  # single instance -> built-in 1.6s throttle for all calls
    OUT_DIR.mkdir(exist_ok=True)
    date_label = args.date or datetime.now(TZ).strftime("%Y%m%d")

    tasks: list[tuple[str, dict | None]] = []
    if args.matches:
        ids = [x.strip() for x in args.matches.split(",") if x.strip()]
        tasks = [(i, None) for i in ids]
        print(f"[batch] {len(ids)} match id(s) from --matches")
    elif args.date:
        print(f"[batch] fetching matches date={args.date} ...", flush=True)
        metas = matches_for_date(c, args.date, upcoming_only=args.upcoming)
        if args.limit:
            metas = metas[:args.limit]
        tasks = [(m["match_id"], m) for m in metas]
        print(f"[batch] {len(tasks)} football match(es) for {args.date}")
        if not tasks:
            print("[batch] nothing to do")
            return 1
    else:
        print(f"[batch] no --date/--matches — demo match {DEMO_MATCH_ID}")
        tasks = [(DEMO_MATCH_ID, None)]

    results: list[dict] = []
    errors: list[dict] = []
    for i, (mid, meta) in enumerate(tasks, 1):
        print(f"[{i}/{len(tasks)}] {mid} ... ", end="", flush=True)
        t0 = time.time()
        try:
            payload = scout_one(c, mid, meta)
            path = OUT_DIR / f"{mid}.json"
            path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2, default=_json_default),
                encoding="utf-8",
            )
            h = payload["market_hints"]
            print(f"ok ({time.time() - t0:.1f}s) "
                  f"avg_total H/A={h['avg_total_home_last10']}/{h['avg_total_away_last10']} "
                  f"o25={h['over25_home_rate']}/{h['over25_away_rate']} -> {path}")
            results.append(payload)
        except KeyboardInterrupt:
            print("interrupted")
            break
        except Exception as e:
            print(f"FAIL: {e}")
            errors.append({"match_id": mid, "error": str(e)})

    report = {
        "date": date_label,
        "generated_at": datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(results),
        "errors": errors,
        "matches": results,
    }
    report_path = Path(f"scout_report_{date_label}.json")
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, default=_json_default),
        encoding="utf-8",
    )
    print(f"[batch] done: {len(results)} ok, {len(errors)} failed -> {report_path}")
    return 0 if results else 1


if __name__ == "__main__":
    raise SystemExit(main())
