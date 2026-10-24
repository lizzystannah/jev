"""AiScore API client â€” protobuf schema-driven, curl_cffi (Cloudflare bypass).

Validated endpoints (2026-09-23):
  GET /v1/web/api/matches?lang=4&sport_id=1&date=YYYYMMDD&tz=-03:00
  GET /v1/web/api/match/data?match_id=
  GET /v1/web/api/match/history?match_id=          (H2H/history)
  GET /v1/web/api/match/lineups?match_id=
  GET /v1/web/api/match/stats?match_id=            (finished only)
  GET /v1/web/api/match/team_stats?match_id=
  GET /v1/web/api/match/incidents?match_id=
  GET /v1/web/api/match/tables?match_id=&lang=     (group standings for match)
  GET /v1/web/api/match/odd?match_id=
  GET /v1/web/api/match/odds_list?match_id=
  GET /v1/web/api/match/odds_detail?match_id=
  GET /v1/web/api/match/odds/detail?match_id=&cid=&odds_type=
  GET /v1/web/api/football/comp?lang=4&comp_id=&season_id=   (WebDbComp incl. tables)
  GET /v1/web/api/football/player?lang=4&player_id=
  GET /v1/web/api/football/team?lang=4&team_id=
  GET /v1/web/api/football/team/matches?team_id=&overview=1&lang=4
  GET /v1/web/api/football/comp/stats?lang=4&season_id=&type=&n=&kind=
  GET /v1/web/api/matches/h2h?sid=&lang=
  GET /v1/web/api/country/comp?lang=4&sport_id=1&country_id=
  GET /v1/web/api/football/comp/map?lang=4&sport_id=1

Standings: also SSR HTML via StealthyFetcher (solves Cloudflare Turnstile).
History/H2H: match_history_parsed(match_id) -> forms, H2H, trends (scores=[FT,1H,2H,...]).
Team history: team_history(team_id) via team/matches + team/month_matches (no match_id).
Scout batch: batch_scout.py --date YYYYMMDD | --matches id1,id2 | demo.
Advanced stats: extract_advanced_stats.py (Over/BTTS/goal windows) -> advanced_stats_*.json.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import curl_cffi.requests as requests

from schema_decode import decode_msg, decode_response, get

BASE = "https://api.aiscore.com/v1/web/api/"
HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.aiscore.com/",
    "Origin": "https://www.aiscore.com",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
}
_ERR_100003 = b"\x08\xa3\x8d\x06"
_DELAY = 1.6


class AiscoreError(Exception):
    pass


class AiscoreClient:
    def __init__(self, delay: float = _DELAY):
        self.delay = delay
        self._last = 0.0
        self.session = requests.Session(impersonate="chrome131")

    def _throttle(self):
        wait = self.delay - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.time()

    def raw(self, path: str, **params) -> bytes:
        """GET protobuf bytes. params omitted if value is None."""
        q = "&".join(f"{k}={v}" for k, v in params.items() if v is not None)
        url = BASE + path + (("?" + q) if q else "")
        self._throttle()
        r = self.session.get(url, headers=HEADERS, timeout=20)
        body = r.content
        if body == _ERR_100003:
            raise AiscoreError(f"route not found: {path}")
        if not body:
            raise AiscoreError(f"empty response (bad params?): {path}?{q}")
        if body[:14] == b"<!DOCTYPE html" or b"Just a moment" in body[:500]:
            raise AiscoreError(f"Cloudflare HTML instead of protobuf: {path}")
        return body

    def msg(self, path: str, msg_name: str, **params):
        return decode_response(self.raw(path, **params), msg_name)

    # ----- daily matches -----
    def matches(self, date: str, sport_id: int = 1, lang: int = 4, tz: str = "+01:00"):
        """date: YYYYMMDD. Returns Response data as generic/named Matches if available."""
        return self.raw(
            "matches", lang=lang, sport_id=sport_id, date=date, tz=tz
        )

    # ----- match -----
    def match_data(self, match_id: str, lang: int = 4, tz: str = "-03:00"):
        return self.msg("match/data", "WebMatchData", match_id=match_id, lang=lang, tz=tz)

    def match_history(self, match_id: str, lang: int = 4):
        return self.raw("match/history", match_id=match_id, lang=lang)

    def match_lineups(self, match_id: str, lang: int = 4):
        return self.raw("match/lineups", match_id=match_id, lang=lang)

    def match_stats(self, match_id: str, lang: int = 4):
        return self.raw("match/stats", match_id=match_id, lang=lang)

    def match_team_stats(self, match_id: str):
        return self.raw("match/team_stats", match_id=match_id)

    def match_incidents(self, match_id: str, lang: int = 4, last_id: str = ""):
        return self.raw("match/incidents", match_id=match_id, lang=lang, last_id=last_id)

    def match_tables(self, match_id: str, lang: int = 4):
        """Group standings related to a match. Returns MatchTables."""
        return self.msg("match/tables", "MatchTables", match_id=match_id, lang=lang)

    def match_odd(self, match_id: str):
        return self.raw("match/odd", match_id=match_id)

    def match_odds_list(self, match_id: str, code: str = "", tab: int | None = None):
        return self.raw("match/odds_list", match_id=match_id, code=code, tab=tab)

    def match_odds_detail(self, match_id: str, cid: str = "", odds_type: str = ""):
        return self.raw(
            "match/odds/detail", match_id=match_id, cid=cid, odds_type=odds_type
        )

    # ----- competition / standings -----
    def competition(self, comp_id: str, season_id: str = "", lang: int = 4):
        """football/comp -> WebDbComp (includes tables/standings + 240 matches)."""
        return self.msg(
            "football/comp", "WebDbComp", lang=lang, comp_id=comp_id, season_id=season_id
        )

    def standings(self, comp_id: str, season_id: str = "", lang: int = 4) -> list[dict]:
        """Named standings rows from WebDbComp.tables.tables[].rows[].fbDetail."""
        comp = self.competition(comp_id, season_id=season_id, lang=lang)
        teams = {}
        for _, name, _, val in comp:
            if name == "teams" and isinstance(val, list):
                teams[get(val, "id")] = get(val, "name")
        wt = next(
            (v for _, n, _, v in comp if n == "tables" and isinstance(v, list)), None
        )
        if not wt:
            return []
        table = next(
            (v for _, n, _, v in wt if n == "tables" and isinstance(v, list)), None
        )
        if not table:
            return []
        out = []
        for _, n, _, row in table:
            if n != "rows" or not isinstance(row, list):
                continue
            team = get(row, "team")
            tid = get(team, "id") if isinstance(team, list) else None
            tname = get(team, "name") if isinstance(team, list) else None
            fb = get(row, "fbDetail")
            rec = {"team": tname or teams.get(tid, tid), "team_id": tid}
            if isinstance(fb, list):
                for k in (
                    "position", "total", "won", "draw", "loss",
                    "goals", "goalsAgainst", "goalDiff", "points",
                ):
                    rec[k] = get(fb, k)
            out.append(rec)
        out.sort(key=lambda r: int(r.get("position") or 0))
        return out

    def team(self, team_id: str, lang: int = 4):
        return self.msg("football/team", "WebDbTeam" if False else "Team",
                        lang=lang, team_id=team_id)

    def team_matches(self, team_id: str, lang: int = 4, overview: int = 1):
        return self.raw(
            "football/team/matches",
            team_id=team_id, overview=overview, lang=lang,
        )

    def player(self, player_id: str, lang: int = 4):
        return self.msg("football/player", "Player", lang=lang, player_id=player_id)

    def comp_stats(self, season_id: str, type_: int = 1, n: int = 10, kind: int = 1, lang: int = 4):
        return self.raw(
            "football/comp/stats",
            lang=lang, season_id=season_id, type=type_, n=n, kind=kind,
        )

    def matches_h2h(self, sid: str, lang: int = 4):
        return self.raw("matches/h2h", sid=sid, lang=lang)

    def match_history_parsed(self, match_id: str, lang: int = 4) -> dict:
        """Structured HistoryMatches for a match: last games, H2H, trends.

        Score layout (football): homeScores/awayScores packed sint32 zigzag
        as [FT, 1H, 2H, ET1, ET2, Pens, ...]  (JS: total = scores[5] || scores[0]).
        """
        return parse_history(self.match_history(match_id, lang=lang))

    def team_history(self, team_id: str, n: int = 10, lang: int = 4,
                     max_months: int = 24, offline: bool = False) -> dict:
        """Last n finished results for a team by team_id (no match_id).

        Seeds from football/team/matches?overview=1 (WebDbTeam window), then
        walks football/team/month_matches?date=yyyyMM&status=-1 backwards.
        EMPTY month = team played no games that month (route still valid).
        offline=True reads only cached team_*.bin (0 API calls).
        """
        from team_history_probe import team_history as _th
        return _th(team_id, n=n, lang=lang, client=self,
                   offline=offline, max_months=max_months)

    def scout_match(self, match_id: str) -> dict:
        """Full scouting payload for one match (forms, H2H, trends, market hints)."""
        from batch_scout import scout_one
        return scout_one(self, match_id)


def decode_packed_sint32(raw) -> list[int]:
    if isinstance(raw, int):
        return [raw]
    if not isinstance(raw, (bytes, bytearray)):
        return []
    out: list[int] = []
    i = 0
    while i < len(raw):
        shift = 0
        v = 0
        try:
            while True:
                x = raw[i]
                i += 1
                v |= (x & 0x7F) << shift
                if not (x & 0x80):
                    break
                shift += 7
        except IndexError:
            break
        out.append((v >> 1) ^ -(v & 1))
    return out


def match_scores(m: list) -> dict:
    """FT/HT scores from Match message. Returns ft_home/ft_away (ints) or None."""
    h = decode_packed_sint32(get(m, "homeScores"))
    a = decode_packed_sint32(get(m, "awayScores"))
    hs, as_ = get(m, "homeScore"), get(m, "awayScore")
    if h and a:
        # football total prefers pens[5] if present else FT[0]
        ft_h = h[5] if len(h) > 5 and h[5] else h[0]
        ft_a = a[5] if len(a) > 5 and a[5] else a[0]
        return {
            "ft_home": ft_h,
            "ft_away": ft_a,
            "ht_home": h[1] if len(h) > 1 else None,
            "ht_away": a[1] if len(a) > 1 else None,
            "periods_home": h,
            "periods_away": a,
        }
    return {"ft_home": hs, "ft_away": as_, "ht_home": None, "ht_away": None,
            "periods_home": [], "periods_away": []}


def _row(m: list, tmap: dict, cmap: dict, team_id: str | None = None) -> dict | None:
    if not isinstance(m, list):
        return None
    home, away = get(m, "homeTeam"), get(m, "awayTeam")
    hid = get(home, "id") if isinstance(home, list) else None
    aid = get(away, "id") if isinstance(away, list) else None
    hname = (get(home, "name") if isinstance(home, list) and get(home, "name") else tmap.get(hid, hid))
    aname = (get(away, "name") if isinstance(away, list) and get(away, "name") else tmap.get(aid, aid))
    sc = match_scores(m)
    status, mstatus = get(m, "statusId"), get(m, "matchStatus")
    finished = status == 8 or mstatus == 3
    comp = get(m, "competition")
    cid = get(comp, "id") if isinstance(comp, list) else None
    cname = get(comp, "name") if isinstance(comp, list) and get(comp, "name") else cmap.get(cid)
    result = gf = ga = None
    if finished and sc["ft_home"] is not None and sc["ft_away"] is not None:
        ref = team_id or hid
        if ref == hid:
            gf, ga = sc["ft_home"], sc["ft_away"]
        else:
            gf, ga = sc["ft_away"], sc["ft_home"]
        result = "W" if gf > ga else ("D" if gf == ga else "L")
    mt = get(m, "matchTime")
    date = None
    if mt:
        from datetime import datetime, timezone, timedelta
        date = datetime.fromtimestamp(int(mt), tz=timezone(timedelta(hours=-3))).strftime("%Y-%m-%d %H:%M")
    return {
        "id": get(m, "id"),
        "date": date,
        "home_id": hid,
        "home": hname,
        "away_id": aid,
        "away": aname,
        "score": f"{sc['ft_home']}-{sc['ft_away']}" if sc["ft_home"] is not None else None,
        "ht": f"{sc['ht_home']}-{sc['ht_away']}" if sc["ht_home"] is not None else None,
        **sc,
        "statusId": status,
        "matchStatus": mstatus,
        "finished": finished,
        "result": result,
        "gf": gf,
        "ga": ga,
        "side": ("home" if hid == team_id else "away") if team_id and hid else None,
        "comp": cname,
        "round": get(m, "roundNum"),
    }


def _appears_all(rows: list) -> str | None:
    sets = [set([r["home_id"], r["away_id"]]) for r in rows if r]
    if not sets:
        return None
    common = sets[0]
    for s in sets[1:]:
        common &= s
    return next(iter(common)) if common else None


def _form(rows: list, n: int = 10) -> dict:
    fin = sorted(
        [r for r in rows if r and r["finished"] and r["result"]],
        key=lambda r: r["date"] or "",
        reverse=True,
    )[:n]
    def wdl(rs):
        return {
            "W": sum(1 for r in rs if r["result"] == "W"),
            "D": sum(1 for r in rs if r["result"] == "D"),
            "L": sum(1 for r in rs if r["result"] == "L"),
        }
    home = [r for r in fin if r["side"] == "home"]
    away = [r for r in fin if r["side"] == "away"]
    return {
        "n": len(fin),
        **wdl(fin),
        "GF": sum(r["gf"] or 0 for r in fin),
        "GA": sum(r["ga"] or 0 for r in fin),
        "form": "".join(r["result"] for r in reversed(fin)),
        "home": wdl(home),
        "away": wdl(away),
        "matches": fin,
    }


def _trend(h: list, name: str) -> dict | None:
    tr = next((v for _, n, _, v in h if n == name and isinstance(v, list)), None)
    if not isinstance(tr, list):
        return None
    out = {}
    for _, n, _, v in tr:
        if n.endswith("Dots") and isinstance(v, bytes):
            out[n] = decode_packed_sint32(v)
        else:
            out[n] = v
    return out


def parse_history(raw: bytes) -> dict:
    """Decode match/history protobuf bytes into structured home/away/H2H/trends."""
    from schema_decode import decode_response  # noqa: F401  (ensure module loaded)
    resp = decode_msg(raw, "Response")
    payload = get(resp, "data")
    if not payload:
        return {"error": "empty", "code": get(resp, "code")}
    h = decode_msg(payload, "HistoryMatches")

    def sec(name):
        return [v for _, n, _, v in h if n == name and isinstance(v, list)]

    tmap = {get(tm, "id"): get(tm, "name") for tm in sec("teams")}
    cmap = {get(c, "id"): get(c, "name") for c in sec("comps")}

    home_rows_raw = sec("home")
    away_rows_raw = sec("away")
    hid = _appears_all([_row(m, tmap, cmap) for m in home_rows_raw])
    aid = _appears_all([_row(m, tmap, cmap) for m in away_rows_raw])

    home = [_row(m, tmap, cmap, team_id=hid) for m in home_rows_raw]
    away = [_row(m, tmap, cmap, team_id=aid) for m in away_rows_raw]
    h2h = [_row(m, tmap, cmap) for m in sec("h2h")]
    h2h_future = [_row(m, tmap, cmap) for m in sec("h2hFuture")]

    # H2H from home-focal perspective
    h2h_sum = {"W": 0, "D": 0, "L": 0}
    for r in h2h:
        if not r or not r["finished"] or r["ft_home"] is None or not hid:
            continue
        if r["home_id"] == hid:
            gf, ga = r["ft_home"], r["ft_away"]
        elif r["home_id"] == aid:
            gf, ga = r["ft_away"], r["ft_home"]
        else:
            continue
        # recompute result for focal
        r["focal_result"] = "W" if gf > ga else ("D" if gf == ga else "L")
        r["focal_gf"], r["focal_ga"] = gf, ga
        h2h_sum[r["focal_result"]] += 1

    return {
        "home_team_id": hid,
        "home_team": tmap.get(hid, hid),
        "away_team_id": aid,
        "away_team": tmap.get(aid, aid),
        "home_form": _form(home),
        "away_form": _form(away),
        "h2h": h2h,
        "h2h_future": h2h_future,
        "h2h_summary": h2h_sum,
        "home_trend": _trend(h, "homeTrend"),
        "away_trend": _trend(h, "awayTrend"),
        "home_trend_sc": _trend(h, "homeTrendSc"),
        "away_trend_sc": _trend(h, "awayTrendSc"),
        "home_matches": home,
        "away_matches": away,
    }


def standings_from_html(html_path: str = "standings_page.html") -> list[dict]:
    """Fallback: parse SSR standings HTML (Cloudflare via Scrapling StealthyFetcher)."""
    import re

    html = Path(html_path).read_text(encoding="utf-8")
    idx = html.find(">Pts<")
    region = html[idx:]
    starts = [
        m.start()
        for m in re.finditer(r'<div data-team-id="[^"]+" class="row', region)
    ]
    rows = []
    for i, s in enumerate(starts):
        e = starts[i + 1] if i + 1 < len(starts) else s + 20000
        chunk = region[s:e]
        tid = re.search(r'data-team-id="([^"]+)"', chunk).group(1)
        name_m = re.search(
            r'<span class="ml-xs team-name[^"]*"[^>]*>\s*([^<]+?)\s*</span>', chunk
        )
        name = name_m.group(1).strip() if name_m else tid
        rank_m = re.search(r'<span class="num"[^>]*>\s*(\d+)\s*</span>', chunk)
        rank = int(rank_m.group(1)) if rank_m else i + 1
        a, b = chunk.find("pwdl"), chunk.find("col goals")
        seg = chunk[a:b] if a >= 0 and b > a else ""
        nums = re.findall(r">\s*(\d+)\s*<", seg)
        P, W, D, L = map(int, nums[:4])
        goals_m = re.search(
            r'class="col goals[^"]*"[^>]*>\s*([0-9]+:[0-9]+)\s*<', chunk, re.S
        )
        rows.append(
            {
                "position": str(rank),
                "team": name,
                "team_id": tid,
                "total": str(P),
                "won": str(W),
                "draw": str(D),
                "loss": str(L),
                "goals": goals_m.group(1) if goals_m else "?",
                "points": str(3 * W + D),
            }
        )
    rows.sort(key=lambda r: int(r["position"]))
    return rows


if __name__ == "__main__":
    c = AiscoreClient()
    ELITE = "1edq09iynayqxgo"
    SEASON = "xvkjoi9r9osp793"

    table = c.standings(ELITE, season_id=SEASON)
    print("API standings (football/comp):")
    for r in table:
        print(
            f' {r.get("position"):>2} {r["team"]:24} '
            f'{r.get("total"):>3} {r.get("won")}-{r.get("draw")}-{r.get("loss")} '
            f'{r.get("goals")} {r.get("points")} pts'
        )

    Path("standings_final.json").write_text(
        json.dumps(table, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("\nsaved standings_final.json")

    # sanity vs HTML
    html_rows = standings_from_html()
    api_pts = [(r["team_id"], r.get("points")) for r in table]
    html_pts = [(r["team_id"], r.get("points")) for r in html_rows]
    print("API==HTML points:", api_pts == html_pts)

