"""Advanced stats from HistoryMatches bins (betting/scout view).

Inputs : hist_future.bin (Andorra x Malta), hist_fin.bin (Kosovo x Andorra)
Outputs: advanced_stats_<label>.json + compact stdout report

Uses aiscore_client (read-only): decode_packed_sint32, match_scores, parse_history.
GoalDistribution is decoded here from raw bytes because schema_decode resolves the
nested `GoalDistribution.Item` type to the first `Item` found (ChatTranslateLanguages.Item).
"""
from __future__ import annotations

import json
from pathlib import Path

from aiscore_client import decode_packed_sint32, match_scores, parse_history
from schema_decode import decode_msg, get

BINS = [("future", "hist_future.bin"), ("finished", "hist_fin.bin")]
LAST_N = 10

# ---------------------------------------------------------------- GoalDistribution

def _rv(b, i):
    s = 0
    v = 0
    while True:
        x = b[i]
        i += 1
        v |= (x & 0x7F) << s
        if not (x & 0x80):
            break
        s += 7
    return v, i


def _walk(b):
    out, i = [], 0
    while i < len(b):
        k, i = _rv(b, i)
        fn, wt = k >> 3, k & 7
        if wt == 0:
            v, i = _rv(b, i)
            out.append((fn, 0, v))
        elif wt == 2:
            ln, i = _rv(b, i)
            out.append((fn, 2, b[i:i + ln]))
            i += ln
        elif wt == 1:
            out.append((fn, 1, b[i:i + 8]))
            i += 8
        elif wt == 5:
            out.append((fn, 5, b[i:i + 4]))
            i += 4
        else:
            break
    return out


_STAT_ITEM = {1: "total", 2: "percentage", 3: "startTime", 4: "endTime"}
_GD_SIDE = {1: "all", 2: "home", 3: "away"}
# schema defines StatItem.total/percentage/startTime/endTime but the wire only
# carries `total`; the 6 positional buckets are time windows (server omits 0s).
WINDOWS = ["0-15", "16-30", "31-45", "46-60", "61-75", "76-90+"]


def _decode_item(b):
    item = {"matches": None, "scored": [], "conceded": []}
    for fn, wt, val in _walk(b):
        if fn == 1 and wt == 0:
            item["matches"] = val
        elif fn in (2, 3) and wt == 2:
            st = {k: 0 for k in _STAT_ITEM.values()}
            for f2, w2, v2 in _walk(val):
                name = _STAT_ITEM.get(f2)
                if name and w2 == 0:
                    st[name] = v2
            item["scored" if fn == 2 else "conceded"].append(st)
    return item


def decode_goal_distributions(raw_history_bytes: bytes, tmap: dict) -> list[dict]:
    resp = decode_msg(raw_history_bytes, "Response")
    payload = get(resp, "data")
    out = []
    if not isinstance(payload, bytes):
        return out
    for fn, wt, val in _walk(payload):
        if fn != 13 or wt != 2:  # HistoryMatches.goalDistributions (id 13)
            continue
        gd = {"team_id": None, "team": None, "season_id": None}
        for f, w, v in _walk(val):
            if f in (1, 2, 3) and w == 2:
                gd[_GD_SIDE[f]] = _decode_item(v)
            elif f == 4 and w == 2:
                sid = [x for ff, ww, x in _walk(v) if ff == 1 and ww == 2]
                gd["season_id"] = sid[0].decode("utf-8", "replace") if sid else None
            elif f == 5 and w == 2:
                tid = [x for ff, ww, x in _walk(v) if ff == 1 and ww == 2]
                gd["team_id"] = tid[0].decode("utf-8", "replace") if tid else None
        gd["team"] = tmap.get(gd["team_id"], gd["team_id"])
        for side in ("all", "home", "away"):
            it = gd.get(side)
            if not it:
                continue
            it["scored_by_window"] = {
                WINDOWS[i] if i < len(WINDOWS) else f"w{i + 1}": (st.get("total") or 0)
                for i, st in enumerate(it["scored"])
            }
            it["conceded_by_window"] = {
                WINDOWS[i] if i < len(WINDOWS) else f"w{i + 1}": (st.get("total") or 0)
                for i, st in enumerate(it["conceded"])
            }
            it["scored_total"] = sum(st.get("total") or 0 for st in it["scored"])
            it["conceded_total"] = sum(st.get("total") or 0 for st in it["conceded"])
        out.append(gd)
    return out


# ---------------------------------------------------------------- team stats

def _finished_rows(rows: list) -> list:
    fin = [
        r for r in rows
        if r and r["finished"] and r["ft_home"] is not None and r["ft_away"] is not None
    ]
    fin.sort(key=lambda r: r["date"] or "", reverse=True)
    return fin


def _rate(hit: int, n: int) -> dict:
    return {"count": hit, "n": n, "pct": round(100.0 * hit / n, 1) if n else None}


def team_stats(rows: list) -> dict:
    """rows: parse_history home_matches/away_matches (result/gf/ga vs focal team)."""
    fin = _finished_rows(rows)
    out = {"available": len(fin)}
    for key, sel in (("last10", fin[:LAST_N]), ("all", fin)):
        n = len(sel)
        totals = [(r["ft_home"] or 0) + (r["ft_away"] or 0) for r in sel]
        gf = [r["gf"] or 0 for r in sel]
        ga = [r["ga"] or 0 for r in sel]
        btts = sum(1 for r in sel if (r["ft_home"] or 0) > 0 and (r["ft_away"] or 0) > 0)
        ht_pairs = [
            (r["ht_home"], r["ht_away"])
            for r in sel
            if r.get("ht_home") is not None and r.get("ht_away") is not None
        ]
        venue = {}
        for side in ("home", "away"):
            vs = [r for r in sel if r["side"] == side]
            venue[side] = {
                "n": len(vs),
                "W": sum(1 for r in vs if r["result"] == "W"),
                "D": sum(1 for r in vs if r["result"] == "D"),
                "L": sum(1 for r in vs if r["result"] == "L"),
                "GF": sum(r["gf"] or 0 for r in vs),
                "GA": sum(r["ga"] or 0 for r in vs),
            }
        out[key] = {
            "n": n,
            "W": sum(1 for r in sel if r["result"] == "W"),
            "D": sum(1 for r in sel if r["result"] == "D"),
            "L": sum(1 for r in sel if r["result"] == "L"),
            "GF": sum(gf),
            "GA": sum(ga),
            "avg_gf": round(sum(gf) / n, 2) if n else None,
            "avg_ga": round(sum(ga) / n, 2) if n else None,
            "avg_total_goals": round(sum(totals) / n, 2) if n else None,
            "over15": _rate(sum(1 for t in totals if t > 1.5), n),
            "over25": _rate(sum(1 for t in totals if t > 2.5), n),
            "over35": _rate(sum(1 for t in totals if t > 3.5), n),
            "btts": _rate(btts, n),
            "clean_sheets": sum(1 for x in ga if x == 0),
            "failed_to_score": sum(1 for x in gf if x == 0),
            "avg_1h_goals": (
                round(sum(h + a for h, a in ht_pairs) / len(ht_pairs), 2)
                if ht_pairs else None
            ),
            "ht_n": len(ht_pairs),
            "venue": venue,
            "form_last5": "".join(
                r["result"] or "?" for r in reversed(sel[:5])
            ),
            "form_last10": "".join(
                r["result"] or "?" for r in reversed(sel[:10])
            ),
            "totals": totals,
            "matches": [
                {
                    "date": r["date"], "side": r["side"],
                    "home": r["home"], "away": r["away"],
                    "score": r["score"], "ht": r["ht"],
                    "result": r["result"], "gf": r["gf"], "ga": r["ga"],
                    "total": (r["ft_home"] or 0) + (r["ft_away"] or 0),
                    "btts": (r["ft_home"] or 0) > 0 and (r["ft_away"] or 0) > 0,
                    "comp": r["comp"],
                }
                for r in sel
            ],
        }
    return out


def _unzigzag(vals) -> list[int]:
    """aiscore_client._trend decodes Dots with decode_packed_sint32 (zigzag),
    but the wire carries plain varints 0/1 -> undo the zigzag mapping."""
    out = []
    for v in vals or []:
        out.append(2 * v if v >= 0 else -2 * v - 1)
    return out


def trend_check(trend: dict | None, stats: dict) -> dict:
    """Sanity: trend.overGoals/bothScore vs recomputed from last-10 match list.

    Semantics discovered:
      overGoals = matches where FOCAL TEAM scored 3+ (team over 2.5)
      bothScore = BTTS count
      *Dots     = plain varint 0/1 per recent match, newest-first (len 3)
    """
    if not trend:
        return {"available": False}
    fin = stats["last10"]["matches"]
    n = len(fin)
    og_dots = _unzigzag(trend.get("overGoalsDots"))
    bs_dots = _unzigzag(trend.get("bothScoreDots"))
    rec_og_series = [1 if m["gf"] >= 3 else 0 for m in fin[:len(og_dots)]]
    rec_bs_series = [1 if m["btts"] else 0 for m in fin[:len(bs_dots)]]
    re = {
        "n_listed": trend.get("matches"),
        "n_recomputed": n,
        "trend_overGoals": trend.get("overGoals") or 0,
        "trend_overGoalsDots_raw_zigzag": trend.get("overGoalsDots"),
        "trend_overGoalsDots": og_dots,
        "trend_bothScore": trend.get("bothScore") or 0,
        "trend_bothScoreDots_raw_zigzag": trend.get("bothScoreDots"),
        "trend_bothScoreDots": bs_dots,
        "recomputed_over15": sum(1 for m in fin if m["total"] > 1.5),
        "recomputed_over25": sum(1 for m in fin if m["total"] > 2.5),
        "recomputed_over35": sum(1 for m in fin if m["total"] > 3.5),
        "recomputed_team_over25": sum(1 for m in fin if m["gf"] >= 3),
        "recomputed_btts": sum(1 for m in fin if m["btts"]),
        "trend_wdl": [trend.get("win"), trend.get("draw"), trend.get("loss")],
        "trend_goals": trend.get("goals"),
        "trend_conceded": trend.get("conceded"),
        "recomputed_gf": stats["last10"]["GF"],
        "recomputed_ga": stats["last10"]["GA"],
    }
    re["goals_match"] = re["trend_goals"] == re["recomputed_gf"] and re["trend_conceded"] == re["recomputed_ga"]
    re["wdl_match"] = re["trend_wdl"] == [stats["last10"]["W"], stats["last10"]["D"], stats["last10"]["L"]]
    re["overGoals_match"] = re["trend_overGoals"] == re["recomputed_team_over25"]
    re["btts_match"] = re["trend_bothScore"] == re["recomputed_btts"]
    re["overGoalsDots_match"] = og_dots == rec_og_series
    re["bothScoreDots_match"] = bs_dots == rec_bs_series
    return re


# ---------------------------------------------------------------- H2H

def h2h_stats(h2h: list, home_id, away_id, home_name) -> dict:
    fin = [r for r in h2h if r and r["finished"] and r["ft_home"] is not None]
    fin.sort(key=lambda r: r["date"] or "", reverse=True)
    n = len(fin)
    totals = [(r["ft_home"] or 0) + (r["ft_away"] or 0) for r in fin]
    # focal perspective (home team of the fixture pair)
    focal = []
    for r in fin:
        if r["home_id"] == home_id:
            gf, ga = r["ft_home"], r["ft_away"]
        elif r["home_id"] == away_id:
            gf, ga = r["ft_away"], r["ft_home"]
        else:
            continue
        focal.append({
            "date": r["date"], "home": r["home"], "away": r["away"],
            "score": r["score"], "ht": r["ht"],
            "result": "W" if gf > ga else ("D" if gf == ga else "L"),
            "gf": gf, "ga": ga,
            "total": (r["ft_home"] or 0) + (r["ft_away"] or 0),
            "btts": (r["ft_home"] or 0) > 0 and (r["ft_away"] or 0) > 0,
        })
    # longest unbeaten run for home focal team, chronological
    asc = sorted(focal, key=lambda r: r["date"] or "")
    best = cur = 0
    best_end = None
    for i, r in enumerate(asc):
        if r["result"] != "L":
            cur += 1
            if cur > best:
                best, best_end = cur, i
        else:
            cur = 0
    unbeaten_span = None
    if best_end is not None:
        span = asc[best_end - best + 1:best_end + 1]
        unbeaten_span = {"from": span[0]["date"], "to": span[-1]["date"], "results": "".join(r["result"] for r in span)}
    return {
        "n_finished": n,
        "over15": _rate(sum(1 for t in totals if t > 1.5), n),
        "over25": _rate(sum(1 for t in totals if t > 2.5), n),
        "over35": _rate(sum(1 for t in totals if t > 3.5), n),
        "btts": _rate(sum(1 for f in focal if f["btts"]), n),
        "clean_sheets_focal": sum(1 for f in focal if f["ga"] == 0),
        "focal_wdl": {
            "W": sum(1 for f in focal if f["result"] == "W"),
            "D": sum(1 for f in focal if f["result"] == "D"),
            "L": sum(1 for f in focal if f["result"] == "L"),
        },
        "focal_unbeaten_run_longest": best,
        "focal_unbeaten_span": unbeaten_span,
        "focal_team": home_name,
        "matches": focal,
        "matches_total_order": [
            {"date": r["date"], "home": r["home"], "score": r["score"], "away": r["away"], "total": t}
            for r, t in zip(fin, totals)
        ],
    }


# ---------------------------------------------------------------- main

def pct(d):
    return f"{d['count']}/{d['n']} ({d['pct'] if d['pct'] is not None else '-'}%)"


def run():
    results = {}
    for label, path in BINS:
        raw = Path(path).read_bytes()
        h = parse_history(raw)
        tmap = {}
        resp = decode_msg(raw, "Response")
        payload = get(resp, "data")
        hm = decode_msg(payload, "HistoryMatches")
        for tm in [v for _, n, _, v in hm if n == "teams" and isinstance(v, list)]:
            tmap[get(tm, "id")] = get(tm, "name")

        gds = decode_goal_distributions(raw, tmap)

        home_stats = team_stats(h["home_matches"])
        away_stats = team_stats(h["away_matches"])
        entry = {
            "label": label,
            "source": path,
            "home_team": h["home_team"],
            "home_team_id": h["home_team_id"],
            "away_team": h["away_team"],
            "away_team_id": h["away_team_id"],
            "goal_distributions": gds,
            "home": {"team": h["home_team"], "stats": home_stats,
                     "trend": h["home_trend"], "trend_check": trend_check(h["home_trend"], home_stats),
                     "trend_sc": h["home_trend_sc"]},
            "away": {"team": h["away_team"], "stats": away_stats,
                     "trend": h["away_trend"], "trend_check": trend_check(h["away_trend"], away_stats),
                     "trend_sc": h["away_trend_sc"]},
            "h2h": h2h_stats(h["h2h"], h["home_team_id"], h["away_team_id"], h["home_team"]),
            "h2h_future": h.get("h2h_future") or [],
        }
        results[label] = entry

        outp = Path(f"advanced_stats_{label}.json")
        outp.write_text(json.dumps(entry, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

        # -------- compact report --------
        print("=" * 78)
        print(f"[{label.upper()}] {h['home_team']} x {h['away_team']}  ({path})")
        print(f"GoalDistribution entries: {len(gds)}"
              + ("" if gds else "  (none in this bin)"))
        for gd in gds:
            print(f"  {gd['team']} season={gd['season_id']}")
            for side in ("all", "home", "away"):
                it = gd.get(side)
                if not it:
                    continue
                print(f"    {side:5} matches={it['matches']} "
                      f"scored={it['scored_by_window']} (Σ{it['scored_total']}) "
                      f"conceded={it['conceded_by_window']} (Σ{it['conceded_total']})")
        for key in ("home", "away"):
            blk = results[label][key]
            s = blk["stats"]
            print(f"\n  {blk['team']}:")
            for seg in ("last10", "all"):
                d = s[seg]
                if d["n"] == 0:
                    print(f"    {seg}: no finished matches")
                    continue
                v = d["venue"]
                print(
                    f"    {seg:6} n={d['n']:2} W{d['W']}-D{d['D']}-L{d['L']} "
                    f"GF{d['GF']}:GA{d['GA']} avg {d['avg_gf']}/{d['avg_ga']} "
                    f"1H_avg={d['avg_1h_goals']} form5={d['form_last5']}"
                )
                print(
                    f"             O1.5 {pct(d['over15'])} | O2.5 {pct(d['over25'])} | "
                    f"O3.5 {pct(d['over35'])} | BTTS {pct(d['btts'])} | "
                    f"CS={d['clean_sheets']} FTS={d['failed_to_score']}"
                )
                print(
                    f"             home W{v['home']['W']}-{v['home']['D']}-{v['home']['L']}"
                    f" ({v['home']['GF']}:{v['home']['GA']}) | "
                    f"away W{v['away']['W']}-{v['away']['D']}-{v['away']['L']}"
                    f" ({v['away']['GF']}:{v['away']['GA']})"
                )
            tc = blk["trend_check"]
            if tc.get("available", True) and tc.get("n_recomputed") is not None:
                print(
                    f"    trend check: overGoals={tc['trend_overGoals']} "
                    f"(dots={tc['trend_overGoalsDots']}) vs team-GF>=3 "
                    f"O2.5={tc['recomputed_team_over25']} match={tc['overGoals_match']} "
                    f"dots_match={tc['overGoalsDots_match']} | "
                    f"O1.5={tc['recomputed_over15']} O2.5={tc['recomputed_over25']} "
                    f"O3.5={tc['recomputed_over35']} (match totals, informational)"
                )
                print(
                    f"                 bothScore={tc['trend_bothScore']} "
                    f"(dots={tc['trend_bothScoreDots']}) vs BTTS={tc['recomputed_btts']} "
                    f"match={tc['btts_match']} dots_match={tc['bothScoreDots_match']} | "
                    f"goals {tc['trend_goals']}/{tc['trend_conceded']} vs "
                    f"{tc['recomputed_gf']}/{tc['recomputed_ga']} match={tc['goals_match']} "
                    f"wdl_match={tc['wdl_match']}"
                )
        hs = results[label]["h2h"]
        print(f"\n  H2H ({hs['n_finished']} finished, focal={hs['focal_team']}):")
        if hs["n_finished"]:
            print(f"    O1.5 {pct(hs['over15'])} | O2.5 {pct(hs['over25'])} | "
                  f"O3.5 {pct(hs['over35'])} | BTTS {pct(hs['btts'])} | "
                  f"CS_focal={hs['clean_sheets_focal']}")
            f = hs["focal_wdl"]
            print(f"    focal W{f['W']}-D{f['D']}-L{f['L']} | longest unbeaten run="
                  f"{hs['focal_unbeaten_run_longest']} {hs['focal_unbeaten_span']}")
        print(f"\n  saved advanced_stats_{label}.json")

    # -------- validation (Andorra in FUTURE bin) --------
    fut = results["future"]
    hs = fut["home"]["stats"]["last10"]
    checks = {
        "andorra_last10_GF_5": hs["GF"] == 5,
        "andorra_last10_GA_16": hs["GA"] == 16,
        "andorra_last10_over25_4_of_10": hs["over25"]["count"] == 4 and hs["over25"]["n"] == 10,
        "totals_match_manual": hs["totals"] == [3, 2, 1, 0, 2, 4, 1, 4, 4, 0],
        "last10_n_is_10": hs["n"] == 10,
    }
    print("=" * 78)
    print("VALIDATION (Andorra last-10, FUTURE bin):")
    print(f"  GF={hs['GF']} (expect 5) | GA={hs['GA']} (expect 16) | "
          f"totals={hs['totals']}")
    print(f"  Over2.5 = {hs['over25']['count']}/{hs['over25']['n']} (expect 4/10)")
    for k, ok in checks.items():
        print(f"  {'PASS' if ok else 'FAIL'}: {k}")
    ok_all = all(checks.values())
    print(f"RESULT: {'ALL PASS' if ok_all else 'FAILED'}")
    return ok_all


if __name__ == "__main__":
    raise SystemExit(0 if run() else 1)
