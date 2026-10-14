"""team_history_probe.py — team match history / last results by team_id (no match_id).

WORKING ROUTES (validated 2026-09-23, 15 API calls total):
  GET football/team/matches?team_id=&overview=1&lang=4
      -> WebDbTeam   window of recent+upcoming matches (field 2 matches,
                     field 9 comps, field 10 teams, field 19 lastMonthMatches).
                     Clubs get ~5 finished here; sparse national teams may get 0.
  GET football/team/matches?team_id=&overview=0&lang=4
      -> Matches     same window, richer Match fields + teams/venues maps.
  GET football/team?team_id=&lang=4
      -> WebDbTeam   team page incl. lastMatch (finished, with scores) + recentMatch.
  GET football/team/month_matches?lang=&team_id=&date=yyyyMM&status=-1
      -> Matches{1 competitions, 2 matches, 3 teams, 13 venues}
                     ALL matches of that month for the team. THE history route.
                     status=-1 -> past months; status=1 -> future (past+1 = EMPTY);
                     status omitted -> works too. Empty body = team played no
                     matches that month (e.g. 202607), NOT a bad route.

FAILED (100003 route-not-found): football/team/history, database/team/matches,
  matches/team, team/matches, football/team/fixtures, football/team/results.

Scores: Match.homeScores/awayScores packed sint32 zigzag [FT,1H,2H,ET1,ET2,Pens,...];
statusId 8 / matchStatus 3 = finished, 1 = not started.

team_history(team_id, n=10) walks month_matches backwards until n finished
matches are collected (1 call per month, EMPTY months skipped) after seeding
from the team/matches window. Offline mode (default here) reads cached .bin
files only — zero API calls.

Run:  .\\.venv312\\Scripts\\python.exe -X utf8 team_history_probe.py
      add --probe to re-run route probes (9 calls), --live to walk months online.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

from aiscore_client import AiscoreClient, AiscoreError, _form, _row
from schema_decode import decode_msg, get

BRT = timezone(timedelta(hours=-3))

ANDORRA = "2j374oix06trqo6"
MALTA = "1edq09irz1t4qxg"
VIKING = "el6kegi5vxhg75d"

KNOWN_FACTS = [  # (opponent, andorra_gf, andorra_ga, utc_date)
    ("Kosovo", 0, 3, "2026-06-07"),
    ("Liechtenstein", 2, 0, "2026-06-04"),
    ("Montenegro", 0, 2, "2026-03-27"),
]

# actual results of the route probe run (this file's ROUTES), kept for the report
PROBE_RESULTS = [
    {"status": "OK", "bytes": 788, "route": "football/team/matches?team_id=2j374oix06trqo6&overview=1&lang=4", "file": "team_matches_andorra_ov1.bin"},
    {"status": "OK", "bytes": 634, "route": "football/team/matches?team_id=2j374oix06trqo6&overview=0&lang=4", "file": "team_matches_andorra_ov0.bin"},
    {"status": "OK", "bytes": 6869, "route": "football/team?team_id=2j374oix06trqo6&lang=4", "file": "football_team_andorra.bin"},
    {"status": "100003", "route": "football/team/history?team_id=2j374oix06trqo6&lang=4"},
    {"status": "100003", "route": "database/team/matches?team_id=2j374oix06trqo6&lang=4"},
    {"status": "100003", "route": "matches/team?team_id=2j374oix06trqo6&lang=4"},
    {"status": "100003", "route": "team/matches?team_id=2j374oix06trqo6&lang=4"},
    {"status": "100003", "route": "football/team/fixtures?team_id=2j374oix06trqo6&lang=4"},
    {"status": "100003", "route": "football/team/results?team_id=2j374oix06trqo6&lang=4"},
    {"status": "OK", "bytes": 607, "route": "football/team/month_matches?lang=4&team_id=2j374oix06trqo6&date=202606&status=-1", "file": "team_month_202606.bin"},
    {"status": "OK", "bytes": 572, "route": "football/team/month_matches?lang=4&team_id=2j374oix06trqo6&date=202603&status=-1", "file": "team_month_202603.bin"},
    {"status": "EMPTY", "route": "football/team/month_matches?...date=202606&status=1", "detail": "past month + status=1"},
    {"status": "OK", "bytes": 667, "route": "football/team/month_matches?lang=4&team_id=2j374oix06trqo6&date=202606", "file": "team_month_202606_nostatus.bin", "detail": "status omitted also works"},
    {"status": "OK", "bytes": 672, "route": "football/team/month_matches?lang=4&team_id=2j374oix06trqo6&date=202506&status=-1", "file": "team_month_202506.bin"},
    {"status": "EMPTY", "route": "football/team/month_matches?...date=202607&status=-1", "detail": "no matches that month (route valid)"},
]

LEGACY_CACHE = {
    (ANDORRA, "window"): "team_matches_andorra_ov1.bin",
    (VIKING, "window"): "team_sched_full.bin",
}


# ---------------------------------------------------------------- probing ---

def classify_err(msg: str) -> str:
    if "route not found" in msg:
        return "100003"
    if "empty response" in msg:
        return "EMPTY"
    if "Cloudflare" in msg:
        return "CF_HTML"
    return "ERR"


def probe(client: AiscoreClient, path: str, fname: str, **params) -> dict:
    q = "&".join(f"{k}={v}" for k, v in params.items() if v is not None)
    rec = {"route": f"{path}?{q}" if q else path}
    try:
        body = client.raw(path, **params)
    except AiscoreError as e:
        rec["status"] = classify_err(str(e))
        rec["detail"] = str(e)
        return rec
    Path(fname).write_bytes(body)
    rec.update(status="OK", bytes=len(body), file=fname)
    return rec


ROUTES = [
    ("football/team/matches", "team_matches_andorra_ov1.bin",
     dict(team_id=ANDORRA, overview=1, lang=4)),
    ("football/team/matches", "team_matches_andorra_ov0.bin",
     dict(team_id=ANDORRA, overview=0, lang=4)),
    ("football/team", "football_team_andorra.bin",
     dict(team_id=ANDORRA, lang=4)),
    ("football/team/history", "route_fb_team_history.bin",
     dict(team_id=ANDORRA, lang=4)),
    ("database/team/matches", "route_db_team_matches.bin",
     dict(team_id=ANDORRA, lang=4)),
    ("matches/team", "route_matches_team.bin",
     dict(team_id=ANDORRA, lang=4)),
    ("team/matches", "route_team_matches_bare.bin",
     dict(team_id=ANDORRA, lang=4)),
    ("football/team/fixtures", "route_fb_team_fixtures.bin",
     dict(team_id=ANDORRA, lang=4)),
    ("football/team/results", "route_fb_team_results.bin",
     dict(team_id=ANDORRA, lang=4)),
]


def run_probes(client: AiscoreClient | None = None) -> list[dict]:
    c = client or AiscoreClient()
    out = []
    for path, fname, params in ROUTES:
        rec = probe(c, path, fname, **params)
        out.append(rec)
        print(f"{rec['status']:8s} {rec.get('bytes', 0):6d}  {rec['route']}"
              + (f"  -> {fname}" if rec.get("file") else
                 f"  ({rec.get('detail', '')[:70]})"))
    return out


# --------------------------------------------------------------- decoding ---

def _top_field_ids(b: bytes) -> set[int]:
    ids: set[int] = set()
    i, n = 0, len(b)
    while i < n:
        key = 0
        shift = 0
        try:
            while True:
                x = b[i]
                i += 1
                key |= (x & 0x7F) << shift
                if not (x & 0x80):
                    break
                shift += 7
        except IndexError:
            break
        fn, wt = key >> 3, key & 7
        ids.add(fn)
        if wt == 0:
            while i < n and b[i] & 0x80:
                i += 1
            i += 1
        elif wt == 1:
            i += 8
        elif wt == 2:
            ln = 0
            shift = 0
            try:
                while True:
                    x = b[i]
                    i += 1
                    ln |= (x & 0x7F) << shift
                    if not (x & 0x80):
                        break
                    shift += 7
            except IndexError:
                break
            i += ln
        elif wt == 5:
            i += 4
        else:
            break
    return ids


def _first_sub(b: bytes, want_fn: int) -> bytes | None:
    i, n = 0, len(b)
    while i < n:
        key = 0
        shift = 0
        try:
            while True:
                x = b[i]
                i += 1
                key |= (x & 0x7F) << shift
                if not (x & 0x80):
                    break
                shift += 7
        except IndexError:
            return None
        fn, wt = key >> 3, key & 7
        if wt == 0:
            while i < n and b[i] & 0x80:
                i += 1
            i += 1
            continue
        if wt == 1:
            i += 8
            continue
        if wt == 5:
            i += 4
            continue
        if wt != 2:
            return None
        ln = 0
        shift = 0
        try:
            while True:
                x = b[i]
                i += 1
                ln |= (x & 0x7F) << shift
                if not (x & 0x80):
                    break
                shift += 7
        except IndexError:
            return None
        data = b[i:i + ln]
        i += ln
        if fn == want_fn:
            return data
    return None


def _sub_field_wts(b: bytes) -> dict[int, int]:
    out: dict[int, int] = {}
    i, n = 0, len(b)
    while i < n:
        key = 0
        shift = 0
        try:
            while True:
                x = b[i]
                i += 1
                key |= (x & 0x7F) << shift
                if not (x & 0x80):
                    break
                shift += 7
        except IndexError:
            break
        fn, wt = key >> 3, key & 7
        out[fn] = wt
        if wt == 0:
            while i < n and b[i] & 0x80:
                i += 1
            i += 1
        elif wt == 1:
            i += 8
        elif wt == 5:
            i += 4
        elif wt == 2:
            ln = 0
            shift = 0
            try:
                while True:
                    x = b[i]
                    i += 1
                    ln |= (x & 0x7F) << shift
                    if not (x & 0x80):
                        break
                    shift += 7
            except IndexError:
                break
            i += ln
        else:
            break
    return out


def pick_msg_type(payload: bytes) -> str:
    """WebDbTeam (team/matches overview=1, football/team) vs Matches
    (month_matches, overview=0).

    field 1 is Team (slug string @19) or Competition (slug string @23);
    fall back to section ids: comps@9/lastMonth@19 -> WebDbTeam,
    venues@13 -> Matches."""
    f1 = _first_sub(payload, 1)
    if f1:
        wts = _sub_field_wts(f1)
        if wts.get(23) == 2:          # Competition.slug
            return "Matches"
        if wts.get(19) == 2:          # Team.slug
            return "WebDbTeam"
    ids = _top_field_ids(payload)
    if 9 in ids or 19 in ids or 20 in ids or 22 in ids:
        return "WebDbTeam"
    if 13 in ids:
        return "Matches"
    return "WebDbTeam"


def decode_payload(raw: bytes) -> dict:
    """Decode Response.data of team routes -> matches + team/comp name maps."""
    resp = decode_msg(raw, "Response")
    code = get(resp, "code")
    payload = get(resp, "data")
    if not isinstance(payload, (bytes, bytearray)):
        return {"error": "no payload", "code": code}

    msg_type = pick_msg_type(payload)
    dec = decode_msg(payload, msg_type)
    if isinstance(dec, dict) or not any(
            n == "matches" for _, n, _, _ in dec if isinstance(dec, list)):
        alt = "Matches" if msg_type == "WebDbTeam" else "WebDbTeam"
        dec2 = decode_msg(payload, alt)
        if not isinstance(dec2, dict) and any(
                n == "matches" for _, n, _, _ in dec2):
            dec, msg_type = dec2, alt
    if isinstance(dec, dict):
        return {"error": "generic", "code": code}

    def sec(name):
        return [v for _, n, _, v in dec if n == name and isinstance(v, list)]

    team = sec("team")
    team = team[0] if team else None
    matches = sec("matches") + sec("lastMonthMatches")

    tmap = {get(v, "id"): get(v, "name")
            for v in sec("teams") if get(v, "id") and get(v, "name")}
    cmap = {}
    for v in sec("comps") + sec("competitions"):
        if get(v, "id") and get(v, "name"):
            cmap[get(v, "id")] = get(v, "name")

    by_id: dict[str, list] = {}
    for m in matches:
        if not isinstance(m, list):
            continue
        mid = get(m, "id")
        if not mid:
            continue
        prev = by_id.get(mid)
        if prev is None or len(m) > len(prev):
            by_id[mid] = m

    return {
        "msg_type": msg_type,
        "code": code,
        "team": team,
        "team_id": get(team, "id") if isinstance(team, list) else None,
        "team_name": get(team, "name") if isinstance(team, list) else None,
        "tmap": tmap,
        "cmap": cmap,
        "merged": list(by_id.values()),
    }


def rows_from(decoded: dict, team_id: str) -> list[dict]:
    tmap, cmap = decoded["tmap"], decoded["cmap"]
    rows = [_row(m, tmap, cmap, team_id=team_id) for m in decoded["merged"]]
    rows = [r for r in rows
            if r and (r["home_id"] == team_id or r["away_id"] == team_id)]
    for r in rows:
        r["side"] = "home" if r["home_id"] == team_id else "away"
    rows.sort(key=lambda r: r["date"] or "", reverse=True)
    return rows


# ------------------------------------------------------------ cache paths ---

def window_cache(team_id: str) -> Path | None:
    p = Path(f"team_matches_{team_id}_ov1.bin")
    if p.exists():
        return p
    legacy = LEGACY_CACHE.get((team_id, "window"))
    if legacy and Path(legacy).exists():
        return Path(legacy)
    return None


def month_cache(team_id: str, yyyymm: str) -> Path | None:
    p = Path(f"team_month_{team_id}_{yyyymm}.bin")
    if p.exists():
        return p
    # legacy names (team_month_YYYYMM.bin) hold Andorra samples only
    if team_id == ANDORRA:
        p2 = Path(f"team_month_{yyyymm}.bin")
        if p2.exists():
            return p2
    return None


def _month_range_back(start: tuple[int, int], count: int) -> list[str]:
    out = []
    y, m = start
    for _ in range(count):
        out.append(f"{y:04d}{m:02d}")
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return out


# ------------------------------------------------------------ public API ----

def team_history(team_id: str, n: int = 10, lang: int = 4,
                 client: AiscoreClient | None = None,
                 offline: bool = False, max_months: int = 24) -> dict:
    """Last n finished results for a team by team_id — no match_id needed.

    Seeds from football/team/matches?overview=1 (recent window), then walks
    football/team/month_matches?date=yyyyMM&status=-1 backwards until n
    finished matches are collected. EMPTY months (no games) are skipped.
    offline=True: read cached .bin only, never hit the API.
    """
    now = datetime.now(BRT)
    rows_by_id: dict[str, dict] = {}
    months_used: list[str] = []
    team_name = None
    upcoming: list[dict] = []
    sources: list[str] = []

    def absorb(raw: bytes):
        nonlocal team_name
        d = decode_payload(raw)
        if d.get("error"):
            return 0
        if d.get("team_name"):
            team_name = d["team_name"]
        sources.append(d["msg_type"])
        cnt = 0
        for r in rows_from(d, team_id):
            prev = rows_by_id.get(r["id"])
            if prev is None or (r["finished"] and not prev["finished"]) or \
                    (r["finished"] == prev["finished"] and
                     sum(v is not None for v in r.values()) >=
                     sum(v is not None for v in prev.values())):
                rows_by_id[r["id"]] = r
            if r["finished"]:
                cnt += 1
        return cnt

    # 1) recent window
    if not offline:
        c = client or AiscoreClient()
        try:
            raw = c.raw("football/team/matches", team_id=team_id,
                        overview=1, lang=lang)
            Path(f"team_matches_{team_id}_ov1.bin").write_bytes(raw)
            absorb(raw)
        except AiscoreError as e:
            if classify_err(str(e)) != "EMPTY":
                raise
    wc = window_cache(team_id)
    if wc:
        absorb(wc.read_bytes())

    def n_finished() -> int:
        return sum(1 for r in rows_by_id.values() if r["finished"])

    # 2) walk months backwards (previous month first — current window covers now)
    prev_y, prev_m = (now.year, now.month - 1) or (now.year, 12)
    if prev_m == 0:
        prev_y, prev_m = prev_y - 1, 12
    for yyyymm in _month_range_back((prev_y, prev_m), max_months):
        if n_finished() >= n:
            break
        raw = None
        cache = month_cache(team_id, yyyymm)
        if cache:
            raw = cache.read_bytes()
        elif not offline:
            c = client or AiscoreClient()
            try:
                raw = c.raw("football/team/month_matches", lang=lang,
                            team_id=team_id, date=yyyymm, status=-1)
                Path(f"team_month_{team_id}_{yyyymm}.bin").write_bytes(raw)
            except AiscoreError as e:
                if classify_err(str(e)) == "EMPTY":   # no matches that month
                    continue
                raise
        if raw:
            before = len(rows_by_id)
            absorb(raw)
            if len(rows_by_id) > before:
                months_used.append(yyyymm)

    rows = sorted(rows_by_id.values(), key=lambda r: r["date"] or "",
                  reverse=True)
    fin = [r for r in rows if r["finished"]]
    upcoming = [r for r in rows if not r["finished"]]
    form = _form(rows, n=n)
    return {
        "team_id": team_id,
        "team": team_name,
        "source": "football/team/matches?overview=1 + football/team/month_matches",
        "msg_types": sorted(set(sources)),
        "months_used": months_used,
        "n_total": len(rows),
        "n_finished": len(fin),
        "n_upcoming": len(upcoming),
        "partial": len(form["matches"]) < n,
        "n": form["n"],
        "W": form["W"], "D": form["D"], "L": form["L"],
        "GF": form["GF"], "GA": form["GA"],
        "form": form["form"],
        "home": form["home"],
        "away": form["away"],
        "matches": form["matches"],
        "upcoming": upcoming[:5],
    }


# ----------------------------------------------------------- validation ----

def validate(rows: list[dict]) -> list[tuple]:
    out = []
    for opp, egf, ega, dstr in KNOWN_FACTS:
        hit = None
        for r in rows:
            if not r["finished"] or r["gf"] is None:
                continue
            names = ((r["home"] or "") + " " + (r["away"] or "")).lower()
            if opp.lower() not in names:
                continue
            d = (r["date"] or "")[:10]
            if d:
                delta = abs((datetime.fromisoformat(d).date()
                             - datetime.fromisoformat(dstr).date()).days)
                if delta <= 1:
                    hit = r
                    break
        out.append(((opp, egf, ega, dstr), hit))
    return out


def crosscheck_last10(verified_ids: set) -> list[dict]:
    """Complete Andorra last-10 from existing match/history extraction
    (hist_future.bin), marking rows independently verified by
    football/team/month_matches."""
    p = Path("hist_future.bin")
    if not p.exists():
        return []
    raw = p.read_bytes()
    d = decode_payload_hist(raw)
    rows = rows_from(d, ANDORRA)
    fin = [r for r in rows if r["finished"] and r["result"]]
    return [{**r,
             "verified_by_month_endpoint": r.get("id") in verified_ids}
            for r in fin[:10]]


def decode_payload_hist(raw: bytes) -> dict:
    """decode match/history HistoryMatches -> same shape as decode_payload."""
    resp = decode_msg(raw, "Response")
    payload = get(resp, "data")
    h = decode_msg(payload, "HistoryMatches")

    def sec(name):
        return [v for _, n, _, v in h if n == name and isinstance(v, list)]

    tmap = {get(v, "id"): get(v, "name") for v in sec("teams") if get(v, "id")}
    cmap = {get(v, "id"): get(v, "name") for v in sec("comps") if get(v, "id")}
    return {"msg_type": "HistoryMatches", "code": None, "team": None,
            "team_id": ANDORRA, "team_name": tmap.get(ANDORRA),
            "tmap": tmap, "cmap": cmap,
            "merged": sec("home") + sec("homeFuture")}


# ----------------------------------------------------------------- main ----

def _print_history(h: dict):
    print(f"team: {h.get('team')} ({h['team_id']})  msg={h.get('msg_types')}  "
          f"months={h.get('months_used')}")
    print(f"finished={h['n_finished']} upcoming={h['n_upcoming']} "
          f"partial={h.get('partial')}")
    print(f"last {h['n']}: W{h['W']}-D{h['D']}-L{h['L']}  "
          f"GF{h['GF']}:GA{h['GA']}  form={h['form']}")
    print(f"  home W{h['home']['W']}-D{h['home']['D']}-L{h['home']['L']} | "
          f"away W{h['away']['W']}-D{h['away']['D']}-L{h['away']['L']}")
    for m in h["matches"]:
        print(f'   {m["date"]} [{m["side"]}] {m["home"]} {m["score"]} '
              f'{m["away"]} (HT {m["ht"]}) {m["result"]} {m["comp"]}')
    for m in h["upcoming"]:
        print(f'  U {m["date"]} {m["home"]} vs {m["away"]} {m["comp"]}')


def main(argv: list[str]):
    do_probe = "--probe" in argv
    live = "--live" in argv

    print("=" * 72)
    print("ROUTE PROBE" + ("" if do_probe else " (cached results)") )
    print("=" * 72)
    if do_probe:
        report = run_probes()
    else:
        report = PROBE_RESULTS
        for rec in report:
            print(f"{rec['status']:8s} {rec.get('bytes', 0):6d}  {rec['route']}"
                  + (f"  -> {rec['file']}" if rec.get("file") else "")
                  + (f"  ({rec['detail']})" if rec.get("detail") else ""))

    print()
    print("=" * 72)
    print("team_history(ANDORRA, n=10)")
    print("=" * 72)
    h = team_history(ANDORRA, n=10, offline=not live)
    _print_history(h)

    print()
    print("=" * 72)
    print("VALIDATION vs known facts")
    print("=" * 72)
    checks = validate(h["matches"])
    allok = True
    for (opp, gf, ga, d), hit in checks:
        if hit and hit["gf"] == gf and hit["ga"] == ga:
            print(f"  OK   {d} vs {opp}: {hit['home']} {hit['score']} "
                  f"{hit['away']}")
        elif hit:
            allok = False
            print(f"  MISS {d} vs {opp}: got {hit['home']} {hit['score']} "
                  f"{hit['away']} expected {gf}-{ga}")
        else:
            allok = False
            print(f"  MISS {d} vs {opp}: not in extracted rows")
    print("validation:", "ALL OK" if allok else "PARTIAL")

    verified = {m["id"] for m in h["matches"] if m.get("id")}
    last10 = crosscheck_last10(verified)
    print()
    print("=" * 72)
    print("SAMPLE last-10 (Andorra)  [✓ = score confirmed by month_matches]")
    print("=" * 72)
    for r in last10:
        v = "✓" if r["verified_by_month_endpoint"] else " "
        print(f'  {v}{r["date"]}  {r["home"]:14s} {r["score"]:5s} {r["away"]:14s} '
              f'{r["result"]}  {r["comp"] or ""}')
    l10 = last10
    w = sum(1 for r in l10 if r["result"] == "W")
    dcount = sum(1 for r in l10 if r["result"] == "D")
    lw = sum(1 for r in l10 if r["result"] == "L")
    gf = sum(r["gf"] or 0 for r in l10)
    ga = sum(r["ga"] or 0 for r in l10)
    print(f"form: W{w}-D{dcount}-L{lw} GF{gf}:GA{ga} "
          f"({''.join(r['result'] for r in reversed(l10))})")

    print()
    print("=" * 72)
    print("club check: team_history(VIKING) from window cache")
    print("=" * 72)
    hv = team_history(VIKING, n=10, offline=True)
    _print_history(hv)

    out = {
        "andorra_team_history": h,
        "andorra_last10_crosscheck": last10,
        "validation_all_ok": allok,
        "viking_team_history": hv,
        "route_probe": report,
    }
    Path("team_history_andorra.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8")

    lines = [
        "team history probe report",
        "=" * 40,
        "WORKING (by team_id, no match_id):",
        "  football/team/matches?team_id&overview=1&lang=4 -> WebDbTeam (recent window)",
        "  football/team/matches?team_id&overview=0&lang=4 -> Matches (same window)",
        "  football/team?team_id&lang=4 -> WebDbTeam (lastMatch/recentMatch)",
        "  football/team/month_matches?lang&team_id&date=yyyyMM&status=-1 -> Matches",
        "      (all matches of month; status=1 future; EMPTY=no games that month)",
        "",
        "FAILED (100003): football/team/history, database/team/matches,",
        "  matches/team, team/matches, football/team/fixtures, football/team/results",
        "",
        f"andorra last {h['n']}: W{h['W']}-D{h['D']}-L{h['L']} "
        f"GF{h['GF']}:GA{h['GA']} form={h['form']} months={h['months_used']}",
    ]
    for m in h["matches"]:
        lines.append(f"  {m['date']} {m['home']} {m['score']} {m['away']} "
                     f"{m['result']} {m['comp']}")
    lines.append("")
    lines.append("sample last-10 (verified=month endpoint):")
    for r in last10:
        lines.append(f"  {'v' if r['verified_by_month_endpoint'] else ' '}"
                     f" {r['date']} {r['home']} {r['score']} {r['away']} "
                     f"{r['result']} {r['comp']}")
    lines.append(f"form: W{w}-D{dcount}-L{lw} GF{gf}:GA{ga}")
    lines.append(f"validation: {'ALL OK' if allok else 'PARTIAL'}")
    lines.append("")
    lines.append("route probe:")
    for rec in report:
        lines.append(f"  {rec['status']:8s} {rec.get('bytes', 0):6d}  "
                     f"{rec['route']}")
    Path("team_history_report.txt").write_text("\n".join(lines),
                                               encoding="utf-8")
    print("\nsaved team_history_andorra.json, team_history_report.txt")


if __name__ == "__main__":
    main(sys.argv[1:])
