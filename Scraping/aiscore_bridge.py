"""JSON bridge for the Bilheteria Node server (child_process -> stdout).

Uses the validated workspace Python stack (curl_cffi + protobuf decoders).
Run with the workspace venv:
  C:\\Users\\eliza\\Documents\\Scraping\\.venv312\\Scripts\\python.exe -X utf8 aiscore_bridge.py '{"action":"status"}'

Payload actions:
  {"action":"scout","match_id":"..."}                 -> full scout (forms/H2H/hints)
  {"action":"history","match_id":"..."}               -> match_history_parsed only
  {"action":"live_result","match_id":"..."}           -> REAL FT/HT score + status (match/data)
  {"action":"matches_date","date":"YYYYMMDD",...}     -> day's football matches
  {"action":"day_card","date":"YYYYMMDD",...}         -> day's matches + 1X2 odds (match/odd)
  {"action":"odds","match_id":"..."}                  -> parse match/odd -> {home,draw,away}
  {"action":"resolve","home":"A","away":"B","date":"YYYY-MM-DD"}
  {"action":"team_history","team_id":"...","n":10}
  {"action":"standings","comp_id":"...","season_id":"..."}
  {"action":"status"}

Always prints one JSON object to stdout (ok|error).
"""
from __future__ import annotations

import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Workspace root (parent of bilheteria project): .../Documents/Scraping
WORKSPACE = Path(__file__).resolve().parents[2]
os.chdir(WORKSPACE)
if str(WORKSPACE) not in sys.path:
    sys.path.insert(0, str(WORKSPACE))

TZ = timezone(timedelta(hours=-3))

# IDs oficiais (AiScore) das competições permitidas nos bilhetes.
# O nome localizado engana ("Premier League egipto/siria/iraque/catar");
# o ID não. Fonte: football/comp/map + day_card.
_COMP_ID_PRIORITY: dict[str, int] = {
    "xo17pji02i37jw5": 0,   # UEFA Champions League
    "2jr7owi6es1q0em": 1,   # UEFA Europa League
    "mo07dni2vfxknxy": 2,   # English Premier League
    "yzrkn6iorbjqle4": 3,   # Spanish La Liga
    "r8lk2di1xb0736d": 4,   # Italian Serie A
    "1edq09ignayqxgo": 5,   # Bundesliga
    "5xvkjoilecr7938": 6,   # Ligue 1
    "n527r3ipms17evx": 7,   # Portuguese Primeira Liga
    "r8lk2dil5t0736d": 7,   # Brazilian Serie A
    "zjek33ien6ivko2": 7,   # UEFA Conference League
    "4ndqmliwou5kveg": 7,   # Turkish Super Lig
    "eg6763ig9s47ryv": 7,   # J1 League (Japan)
    "g63kv9imm6iz7ez": 7,   # Saudi Pro League
    "5xvkjoi25sr7938": 7,   # Serbian Mozzart Bet Superliga (Estrela Vermelha)
    "yzrkn6i2rcjqle4": 8,   # Netherlands Eredivisie
    "n527r3imms17evx": 8,   # Belgian Pro League
    "2j374oixwu4qo6d": 8,   # Mexico Liga MX
    "w34kgmi82i1ko92": 8,   # United States MLS
    "el6kegimxin75dp": 8,   # Greek Super League
    "5wv78ximvcjkrjn": 8,   # Ukrainian Premier League
    "4ndqmligru5kveg": 8,   # Russian Premier League
}

# Divisões inferiores conhecidas: nunca à frente das principais.
_COMP_LOWER_ID: set[str] = {
    "8vrqwnin9sjqn2o",  # English Championship
    "w34kgmixet1ko92",  # 2. Bundesliga
    "g63kv9i9gcz7ezv",  # Italian Serie B
    "9oj7x9i9rhe7g3y",  # Spanish La Liga 2
    "0m2q15i5obp76xw",  # French Ligue 2
    "5wv78xin5hjkrjn",  # Liga Portugal 2
    "59gklzinwwa37xd",  # Liga 3 portuguesa
    "2ezk96i4zs2kn51",  # J2 League (Japan)
    "el6kegilncn75dp",  # Japan Football League (J3/J4)
    "el6kegie0an75dp",  # English Conference North
    "2ezk96i5wc2kn51",  # English Conference South
    "zjek33i66pivko2",  # Saudi First Division
    "mo07dnidd8ixknx",  # Saudi Second Division
    "8vrqwnioo5ujqn2",  # Saudi Youth League
}

# Prioridade de competições (ligas principais primeiro).
# Usado no day_card para que o corte limit/odds_limit não enterre
# Premier League, La Liga, Champions, Europa etc. no meio de 1000+ jogos.
_COMP_PRIORITY: list[tuple[int, str]] = [
    (0, "champions"),
    (0, "liga de campeones"),
    (1, "europa league"),
    (1, "liga europa"),
    (2, "liga premier de inglaterra"),
    (2, "premier league inglesa"),
    (2, "premier league"),
    (3, "la liga"),
    (4, "primera divisi"),  # La Liga / La Liga 2 (espanhol)
    (5, "serie a"),
    (6, "bundesliga"),
    (7, "ligue 1"),
    (8, "brasileir"),
    (9, "liga portugal"),
    (10, "primeira liga"),
    (10, "liga primera de portugal"),
    (7, "conference league"),
    (7, "conferencia"),
    (7, "j1 league"),
    (7, "j1 de japon"),
    (7, "super lig"),
    (7, "süper lig"),
    (7, "liga profesional saud"),
    (7, "saudi pro league"),
    (7, "super liga s"),
    (7, "serbian mozzart bet superliga"),
    (7, "srbij"),
]

# Exclusões por chave (falsos positivos verificados no feed).
_COMP_EXCLUDE: dict[str, tuple[str, ...]] = {
    "champions": ("femen", "women", "mujer", "youth", "u19", "juvenil"),
    "europa league": ("femen", "women", "mujer", "conference"),
    "premier league": (
        "del norte", "northern", "del sur", "southern", "copa",
        "internacional", "u21", "sub21", "sub 21", "s21",
        "femen", "feminin", "women", "mujer",
        "kenya", "kenia", "bhutan", "but", "mongol", "nigeria",
        "ghana", "jamaica", "burundi", "shillong", "estonia",
        "irlanda", "ireland", "wales", "gales", "scotland", "escocia",
        "egip", "siria", "iraq", "catar", "qatar", "libia", "argelia",
    ),
    "la liga": ("copa de la liga",),
    "serie a": ("serie b", "serie c", "serie d", "femen", "feminin", "women", "mujer"),
    "bundesliga": ("femen", "feminin", "women", "mujer"),
    "ligue 1": ("femen", "feminin", "women", "mujer"),
    "brasileir": ("femen", "feminin", "femin", "women", "mujer", "sub20", "sub-20", "juvenil"),
    "liga portugal": ("femen", "women", "mujer"),
    "primeira liga": ("femen", "women", "mujer"),
}


# Qualificadores que rebaixam a prioridade (feminino/base/obscuro).
# Evita p.ex. "Premier League de Butão" ou "Serie A femenina" passar
# à frente das ligas principais masculinas.
_COMP_PENALTY_KEYS = (
    "femenina", "femenino", "feminina", "feminino", "women", "(w)",
    "(mujeres)", "woman", "ladies", "lady",
    "reserva", "reserve", "reserves", "reservas", "filial",
    "u20", "u19", "u23", "u21", "juvenil", "sub-20", "sub20", "sub-23", "sub23",
    "hong kong", "mongol", "nigeria", "ghana", "jamaica",
    "gales", "escocia", "bielorru", "burundi", "panam", "bhutan",
    "nadeshiko", "nepal", "tanzania", "uganda", "kenya", "zambia",
)

# Divisões inferiores: sempre atrás de ligas principais e de campeonatos
# desconhecidos (mas de primeira divisão).
_COMP_LOWER_KEYS = (
    "segunda", "segundo", "intermedia", "reserva", "reservas", "reserve",
    "reserves", "filial", "serie b", "serie c", "serie d",
    "2. bundesliga", "bundesliga 2", "ligue 2", "la liga 2", "laliga 2",
    "hypermotion", "championship", "league one", "league two",
    "national league", "regionalliga", "oberliga", "landesliga",
    "eerste divisie", "tweede divisie", "challenger pro league",
    "primera b", "primera c", "primera nacional", "primera federacion",
    "segunda federacion", "tercera federacion", "tercera division",
    "liga 2", "liga 3", "liga portugal 2", "campeonato de portugal",
    "j2 league", "j2 de japon", "japonesa",
    "conferencia inglesa", "conference north", "conference south",
    "division norte de la conferencia", "division sur de la conferencia",
    "arabia saudita division 1", "arabia saudita division 2",
    "liga juvenil de arabia saudita", "saudi first division", "saudi second division",
)


def _comp_priority(name: str | None, comp_id: str | None = None) -> int:
    cid = (comp_id or "").strip()
    if cid:
        if cid in _COMP_LOWER_ID:
            return 149
        if cid in _COMP_ID_PRIORITY:
            return _COMP_ID_PRIORITY[cid]
        # Competição fora da whitelist: não confiar no nome localizado.
        return 99
    s = (name or "").lower()
    if any(k in s for k in _COMP_LOWER_KEYS):
        return 149
    rank = 99
    for r, key in _COMP_PRIORITY:
        if key not in s:
            continue
        # "Copa de la Liga" (Peru/Bolívia) não é a La Liga espanhola.
        if key == "la liga" and "copa de la liga" in s:
            continue
        # "Primera División X" genérico (Hong Kong, Chile...) não é Espanha.
        if key == "primera divisi" and not any(
            k in s for k in ("spanish", "espa", "rfef", "laliga", "la liga")
        ):
            continue
        # Falsos positivos verificados (ex.: Premier de Butão, U21, Norte).
        if any(x in s for x in _COMP_EXCLUDE.get(key, ())):
            continue
        rank = r
        break
    if rank < 99 and any(k in s for k in _COMP_PENALTY_KEYS):
        rank += 50
    return rank


def _out(obj: dict) -> int:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str))
    sys.stdout.flush()
    return 0


def _normalize_team(name: str) -> str:
    s = unicodedata.normalize("NFKD", (name or "").strip().lower())
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"^(fc|cf|sc|ac|cd|sd|ss|as|sk|rc|afc|cfc)\s+", "", s)
    s = re.sub(r"\s+(fc|cf|sc|ac|cd|sd|ss|as|sk|rc|afc|cfc)$", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _parse_date_any(raw: str) -> datetime | None:
    raw = (raw or "").strip()
    if not raw:
        return None
    for fmt, n in (
        ("%Y-%m-%d %H:%M:%S", 19),
        ("%Y-%m-%d %H:%M", 16),
        ("%Y-%m-%d", 10),
        ("%Y%m%d", 8),
    ):
        try:
            return datetime.strptime(raw[:n], fmt)
        except ValueError:
            continue
    return None


def _iter_fields(buf: bytes):
    i, n = 0, len(buf)
    while i < n:
        key = shift = 0
        while True:
            if i >= n:
                return
            b = buf[i]
            i += 1
            key |= (b & 0x7F) << shift
            if not (b & 0x80):
                break
            shift += 7
        field, wire = key >> 3, key & 7
        if wire == 0:
            v = shift = 0
            while True:
                if i >= n:
                    return
                b = buf[i]
                i += 1
                v |= (b & 0x7F) << shift
                if not (b & 0x80):
                    break
                shift += 7
            yield field, wire, v
        elif wire == 2:
            ln = shift = 0
            while True:
                if i >= n:
                    return
                b = buf[i]
                i += 1
                ln |= (b & 0x7F) << shift
                if not (b & 0x80):
                    break
                shift += 7
            data = buf[i : i + ln]
            i += ln
            yield field, wire, data
        elif wire == 5:
            yield field, wire, buf[i : i + 4]
            i += 4
        elif wire == 1:
            yield field, wire, buf[i : i + 8]
            i += 8
        else:
            return


def _response_data(raw: bytes) -> bytes | None:
    for field, wire, val in _iter_fields(raw):
        if field == 15 and wire == 2:
            return val
    return None


def _strings_in(block: bytes, depth: int = 0) -> list[str]:
    out: list[str] = []
    if depth > 4:
        return out
    for _f, w, v in _iter_fields(block):
        if w != 2:
            continue
        try:
            s = v.decode("utf-8")
        except UnicodeDecodeError:
            s = ""
        if s and all(32 <= ord(c) < 127 for c in s):
            out.append(s)
        else:
            out.extend(_strings_in(v, depth + 1))
    return out


def parse_match_odd(raw: bytes) -> dict | None:
    """match/odd protobuf -> European 1X2 {home, draw, away}.

    Envelope field 15 = data. Field 2 = 1X2 market message; inside it,
    sub-field 4 (else 1) holds repeated string odds [home, draw, away, ...].
    """
    data = _response_data(raw)
    if not data:
        return None
    for field, wire, market in _iter_fields(data):
        if field != 2 or wire != 2:
            continue
        blocks: dict[int, list[str]] = {}
        for f2, w2, v2 in _iter_fields(market):
            if w2 != 2:
                continue
            ss = _strings_in(v2)
            if ss:
                blocks[f2] = ss
        vals = blocks.get(4) or blocks.get(1)
        if not vals or len(vals) < 3:
            continue
        try:
            home, draw, away = float(vals[0]), float(vals[1]), float(vals[2])
        except ValueError:
            continue
        if min(home, draw, away) > 1.0 and max(home, draw, away) < 1000:
            return {
                "home": round(home, 2),
                "draw": round(draw, 2),
                "away": round(away, 2),
            }
    return None


def _resolve_match_id(c, home: str, away: str, date: str) -> dict | None:
    from batch_scout import matches_for_date

    dt = _parse_date_any(date)
    if not dt:
        return None
    ymd = dt.strftime("%Y%m%d")
    metas = matches_for_date(c, ymd, upcoming_only=False)
    hn, an = _normalize_team(home), _normalize_team(away)
    for m in metas:
        mh = _normalize_team((m.get("home") or {}).get("name") or "")
        ma = _normalize_team((m.get("away") or {}).get("name") or "")
        if mh == hn and ma == an:
            return m
    for m in metas:
        mh = _normalize_team((m.get("home") or {}).get("name") or "")
        ma = _normalize_team((m.get("away") or {}).get("name") or "")
        if (hn and hn in mh and an and an in ma) or (hn and hn in ma and an and an in mh):
            return m
    return None


def _full_standings(c, comp_id: str, season_id: str) -> list:
    """Todas as tabelas do football/comp (todos os grupos), com contexto.

    c.standings() só lê a PRIMEIRA tabela — aqui varremos recursivamente
    cada lista que tenha um campo 'rows', herdando name/group/id mais
    próximos. Devolve [{table_id, group, name, rows:[{team_id, team,
    position, total, won, draw, loss, goals, goalsAgainst, goalDiff,
    points}]}]. O Node filtra pelos 2 times do confronto.
    """
    from schema_decode import get as _get

    comp = c.competition(comp_id, season_id=season_id)

    teams: dict = {}

    def collect_teams(node):
        if isinstance(node, tuple) and len(node) == 4:
            _, n, _, v = node
            if n == "teams" and isinstance(v, list):
                for tm in v:
                    if isinstance(tm, list):
                        tid, tname = _get(tm, "id"), _get(tm, "name")
                        if tid:
                            teams[tid] = tname or teams.get(tid)
            if isinstance(v, list):
                for x in v:
                    collect_teams(x)
        elif isinstance(node, list):
            for x in node:
                collect_teams(x)

    collect_teams(comp)

    found: list = []

    def walk(node, ctx):
        if isinstance(node, tuple) and len(node) == 4:
            walk(node[3], ctx)
            return
        if not isinstance(node, list) or not node:
            return
        if all(isinstance(x, tuple) and len(x) == 4 for x in node):
            rows_list: list = []
            meta = dict(ctx)
            for _, n, _, v in node:
                # ATENÇÃO: "rows" repete-se (uma ocorrência = UMA linha);
                # colectam-se todas. Cada valor pode ser uma linha (fields)
                # ou, noutros payloads, lista de linhas.
                if n == "rows" and isinstance(v, list):
                    rows_list.append(v)
                elif n in ("name", "group", "id") and not isinstance(v, list):
                    meta[n] = v
            all_rows: list = []
            for rv in rows_list:
                if rv and all(isinstance(x, list) for x in rv):
                    all_rows.extend(rv)
                elif rv and all(isinstance(x, tuple) for x in rv):
                    all_rows.append(rv)
            if all_rows:
                recs = []
                for r in all_rows:
                    if not isinstance(r, list):
                        continue
                    team = _get(r, "team")
                    fb = _get(r, "fbDetail")
                    tid = _get(team, "id") if isinstance(team, list) else None
                    tname = _get(team, "name") if isinstance(team, list) else None
                    rec = {"team_id": tid, "team": tname or teams.get(tid, tid),
                           "table_id": meta.get("id"), "group": meta.get("group"),
                           "table": meta.get("name")}
                    if isinstance(fb, list):
                        for k in ("position", "total", "won", "draw", "loss",
                                  "goals", "goalsAgainst", "goalDiff", "points"):
                            rec[k] = _get(fb, k)
                    recs.append(rec)
                if recs:
                    found.append({"table_id": meta.get("id"), "group": meta.get("group"),
                                  "name": meta.get("name"), "rows": recs})
                return
        for x in node:
            walk(x, ctx)

    walk(comp, {})
    return found


def _parse_lineups(raw: bytes) -> dict:
    """match/lineups bytes -> escalações resumidas por lado.

    Navegação genérica (f15 envelope -> f1 container): managers (f3/f4),
    confirmed (f5), formations (f6/f7), details f10 (casa) / f11 (fora).
    Detail: team f1, player f2{id}, status f3 (1 = titular; ausente = reserva;
    outro valor = indisponível), reason f4, rating f5, captain f6,
    shirt f7, position f8 (G/D/M/F), incidents f13.
    """
    from decode_raw import decode

    def fields(node):
        return [it for it in (node or [])
                if isinstance(it, tuple) and len(it) == 3]

    def first_msg(items, fn):
        for f, k, v in items:
            if f == fn and k == "msg":
                return v
        return []

    def scalar(items, fn):
        for f, k, v in items:
            if f == fn and k != "msg":
                return v
        return None

    def squad(details) -> dict:
        starters, subs, unavailable = [], [], []
        ratings, by_line = [], {}
        captain_in_xi = False
        for det in details:
            items = fields(det)

            def val(fn, _items=items):
                for f, k, v in _items:
                    if f == fn and k != "msg":
                        return v
                return None

            def sub(fn, _items=items):
                for f, k, v in _items:
                    if f == fn and k == "msg":
                        return v
                return []

            team_id = next((v for f, k, v in fields(sub(1))
                            if f == 1 and k == "str"), None)
            pid = next((v for f, k, v in fields(sub(2))
                        if f == 1 and k == "str"), None)
            st, reason = val(3), val(4)
            rating, captain, pos = val(5), val(6), val(8)
            try:
                rfloat = float(rating) if rating is not None else None
            except (TypeError, ValueError):
                rfloat = None
            entry = {"player_id": pid, "team_id": team_id, "status": st,
                     "reason": reason, "rating": rfloat,
                     "position": pos, "captain": captain == 1}
            if st not in (1, None):
                unavailable.append(entry)
            elif st == 1:
                starters.append(entry)
                if rfloat is not None:
                    ratings.append(rfloat)
                    by_line.setdefault(pos or "?", []).append(rfloat)
                if captain == 1:
                    captain_in_xi = True
            else:
                subs.append(entry)
        avg = round(sum(ratings) / len(ratings), 2) if ratings else None
        return {
            "starters": len(starters),
            "subs": len(subs),
            "avg_rating": avg,
            "by_line": {k: round(sum(v) / len(v), 2) for k, v in by_line.items()},
            "captain_in_xi": captain_in_xi,
            "unavailable": unavailable,
        }

    top = fields(decode(raw))
    inner = first_msg(top, 15)
    lin = first_msg(inner, 1)
    if not lin:
        return {"available": False}
    details_home = [v for f, k, v in lin if f == 10 and k == "msg"]
    details_away = [v for f, k, v in lin if f == 11 and k == "msg"]
    if not details_home and not details_away:
        return {"available": False}

    def manager(fn):
        m = first_msg(lin, fn)
        out = {}
        for f, k, v in fields(m):
            if f == 1 and k == "str":
                out["id"] = v
            elif f == 2 and k == "str":
                out["name"] = v
        return out

    return {
        "available": True,
        "confirmed": scalar(lin, 5),
        "home_formation": scalar(lin, 6),
        "away_formation": scalar(lin, 7),
        "home_manager": manager(3),
        "away_manager": manager(4),
        "home": squad(details_home),
        "away": squad(details_away),
    }


def main(argv: list[str] | None = None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    payload: dict = {}

    if args:
        raw = " ".join(args)
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict):
                payload = obj
        except json.JSONDecodeError:
            payload = {}

    if not payload:
        env = os.environ.get("AISCORE_PAYLOAD", "").strip()
        if env:
            try:
                obj = json.loads(env)
                if isinstance(obj, dict):
                    payload = obj
            except json.JSONDecodeError:
                pass

    if not payload and not sys.stdin.isatty():
        try:
            data = sys.stdin.read()
            if data.strip():
                obj = json.loads(data)
                if isinstance(obj, dict):
                    payload = obj
        except Exception:
            pass

    if not payload:
        return _out({"ok": False, "error": "empty payload"})

    action = str(payload.get("action") or "").lower()

    try:
        from aiscore_client import AiscoreClient, AiscoreError

        c = AiscoreClient()

        if action == "status" or payload.get("ping"):
            import curl_cffi

            return _out({
                "ok": True,
                "type": "status",
                "base": "https://api.aiscore.com/v1/web/api/",
                "throttle_s": getattr(c, "delay", 1.6),
                "curl_cffi": getattr(curl_cffi, "__version__", "ok"),
                "workspace": str(WORKSPACE),
            })

        if action == "scout" or (not action and "match_id" in payload):
            mid = payload.get("match_id")
            if not mid:
                return _out({"ok": False, "error": "match_id required"})
            return _out({"ok": True, "type": "scout", "data": c.scout_match(mid)})

        if action == "history" or payload.get("history_only"):
            mid = payload.get("match_id")
            if not mid:
                return _out({"ok": False, "error": "match_id required"})
            return _out({
                "ok": True,
                "type": "history",
                "data": c.match_history_parsed(mid),
            })

        if action == "advanced":
            # Todas as variáveis restantes do match/history a partir dos
            # MESMOS bytes (sem endpoint extra): GoalDistribution por
            # janelas 0-15..76-90+ (all/home/away), trend_sc, team_stats
            # last10/all e h2h_stats. Ver motor_aiscore.py / TS aiscoreEngine.
            mid = payload.get("match_id")
            if not mid:
                return _out({"ok": False, "error": "match_id required"})
            from aiscore_client import parse_history
            from extract_advanced_stats import (
                decode_goal_distributions,
                h2h_stats,
                team_stats,
            )
            from schema_decode import decode_msg, get as _get

            raw = c.match_history(str(mid))
            h = parse_history(raw)
            if h.get("error") or "home_form" not in h:
                return _out({"ok": False, "error": "history parse failed", "type": "advanced"})
            resp = decode_msg(raw, "Response")
            payload_bytes = _get(resp, "data")
            tmap: dict = {}
            try:
                hm = decode_msg(payload_bytes, "HistoryMatches")
                for _fn, _n, _t, v in hm:
                    if _n == "teams" and isinstance(v, list):
                        tmap[_get(v, "id")] = _get(v, "name")
            except Exception:
                pass
            return _out({
                "ok": True,
                "type": "advanced",
                "data": {
                    "goal_distributions": decode_goal_distributions(raw, tmap),
                    "home_trend_sc": h.get("home_trend_sc"),
                    "away_trend_sc": h.get("away_trend_sc"),
                    "home_stats": team_stats(h.get("home_matches") or []),
                    "away_stats": team_stats(h.get("away_matches") or []),
                    "h2h_stats": h2h_stats(
                        h.get("h2h") or [], h.get("home_team_id"),
                        h.get("away_team_id"), h.get("home_team")),
                },
            })

        if action == "tables":
            # Classificação via football/comp (parser validado). Precisa de
            # comp_id + season_id — o Node passa os do scout/advanced; em
            # falta resolve-se aqui (match/data + goalDistributions).
            # Devolve TODAS as linhas; o Node filtra pelos 2 times.
            mid = payload.get("match_id")
            if not mid:
                return _out({"ok": False, "error": "match_id required"})
            from schema_decode import decode_msg as _dm, get as _get

            comp_id = payload.get("comp_id") or payload.get("competition_id") or ""
            season_id = payload.get("season_id") or ""
            if not comp_id:
                wmd = c.match_data(str(mid))
                _m = _get(wmd, "match")
                _comp = _get(_m, "competition") if isinstance(_m, list) else None
                comp_id = _get(_comp, "id") if isinstance(_comp, list) else None
                if not comp_id:
                    return _out({"ok": False, "error": "no competition id", "type": "tables"})
            if not season_id:
                from extract_advanced_stats import decode_goal_distributions as _gd
                _raw = c.match_history(str(mid))
                _gds = _gd(_raw, {})
                season_id = next((g.get("season_id") for g in _gds if g.get("season_id")), "")
            rows = _full_standings(c, comp_id, season_id)
            return _out({"ok": True, "type": "tables",
                         "data": {"comp_id": comp_id, "season_id": season_id,
                                  "tables": rows}})

        if action == "lineups":
            # Escalações via match/lineups (navegação genérica — o payload traz
            # um wrapper com o Lineup no campo 1). status 1 = titular;
            # qualquer outro status = indisponível (lesão/dúvida) + reason.
            # Sem nomes de jogadores no payload (só IDs) — sem custo extra.
            mid = payload.get("match_id")
            if not mid:
                return _out({"ok": False, "error": "match_id required"})
            return _out({"ok": True, "type": "lineups",
                         "data": _parse_lineups(c.match_lineups(str(mid)))})

        if action == "day_card":
            date = str(payload.get("date") or "")
            if len(date) == 10 and date[4] == "-":
                date = date.replace("-", "")
            if len(date) != 8 or not date.isdigit():
                return _out({"ok": False, "error": "date must be YYYYMMDD or YYYY-MM-DD"})
            from batch_scout import matches_for_date

            metas = matches_for_date(
                c, date, upcoming_only=bool(payload.get("upcoming", True))
            )
            # Ligas principais primeiro — sem isso o limit/odds_limit corta
            # o dia (1000+ jogos) e só sobram ligas obscuras.
            metas.sort(
                key=lambda m: (
                    _comp_priority(m.get("competition"), m.get("competition_id")),
                    m.get("kickoff") or "",
                )
            )
            limit = int(payload.get("limit") or 0)
            if limit:
                metas = metas[:limit]
            odds_limit = int(payload.get("odds_limit") or 15)
            with_odds = bool(payload.get("with_odds", True))
            if with_odds:
                n_odds = 0
                for m in metas:
                    if m.get("statusId") not in (None, 1) or n_odds >= odds_limit:
                        m["odds"] = None
                        continue
                    try:
                        m["odds"] = parse_match_odd(c.match_odd(str(m["match_id"])))
                    except Exception:
                        m["odds"] = None
                    if m["odds"]:
                        n_odds += 1
            return _out({
                "ok": True,
                "type": "day_card",
                "count": len(metas),
                "oddsCount": sum(1 for m in metas if m.get("odds")),
                "data": metas,
            })

        if action == "matches_date" or (not action and "date" in payload):
            date = str(payload.get("date") or "")
            if len(date) == 10 and date[4] == "-":
                date = date.replace("-", "")
            if len(date) != 8 or not date.isdigit():
                return _out({"ok": False, "error": "date must be YYYYMMDD or YYYY-MM-DD"})
            from batch_scout import matches_for_date

            metas = matches_for_date(
                c, date, upcoming_only=bool(payload.get("upcoming"))
            )
            metas.sort(
                key=lambda m: (
                    _comp_priority(m.get("competition"), m.get("competition_id")),
                    m.get("kickoff") or "",
                )
            )
            limit = int(payload.get("limit") or 0)
            if limit:
                metas = metas[:limit]
            return _out({"ok": True, "type": "matches_date", "count": len(metas), "data": metas})

        if action == "odds":
            mid = payload.get("match_id")
            if not mid:
                return _out({"ok": False, "error": "match_id required"})
            odds = parse_match_odd(c.match_odd(str(mid)))
            if not odds:
                return _out({"ok": False, "error": "no 1X2 odds", "type": "odds"})
            return _out({"ok": True, "type": "odds", "data": odds})

        if action == "live_result":
            # Placar REAL via match/data (WebMatchData.match).
            # Fonte da verdade para resolver bilhetes: statusId 8 + matchStatus 3
            # = jogo terminado; FT = scores[0] (nunca somar períodos).
            mid = payload.get("match_id")
            if not mid:
                return _out({"ok": False, "error": "match_id required"})
            from aiscore_client import match_scores as _match_scores
            from aiscore_client import decode_packed_sint32 as _decode_sint
            from batch_scout import kickoff_str as _kickoff_str
            from schema_decode import get as _get

            wmd = c.match_data(str(mid))
            m = _get(wmd, "match")
            if not isinstance(m, list):
                return _out({"ok": False, "error": "no match data", "type": "live_result"})
            sc = _match_scores(m)
            # FT = scores[0] SEMPRE (tempo normal). match_scores() prefere
            # pênaltis[5] em mata-mata — para 1X2/apostas vale o tempo normal.
            raw_h, raw_a = _get(m, "homeScores"), _get(m, "awayScores")
            ph = _decode_sint(raw_h) if isinstance(raw_h, (bytes, bytearray)) else []
            pa = _decode_sint(raw_a) if isinstance(raw_a, (bytes, bytearray)) else []
            ft_home = ph[0] if ph else sc.get("ft_home")
            ft_away = pa[0] if pa else sc.get("ft_away")
            ht_home = ph[1] if len(ph) > 1 else sc.get("ht_home")
            ht_away = pa[1] if len(pa) > 1 else sc.get("ht_away")
            status = _get(m, "statusId")
            mstatus = _get(m, "matchStatus")
            finished = status == 8 or mstatus == 3
            return _out({
                "ok": True,
                "type": "live_result",
                "data": {
                    "match_id": _get(m, "id") or mid,
                    "statusId": status,
                    "matchStatus": mstatus,
                    "finished": finished,
                    "ft_home": ft_home,
                    "ft_away": ft_away,
                    "ht_home": ht_home,
                    "ht_away": ht_away,
                    "kickoff": _kickoff_str(_get(m, "matchTime")),
                },
            })

        if action == "resolve":
            home = payload.get("home") or ""
            away = payload.get("away") or ""
            date = payload.get("date") or ""
            meta = _resolve_match_id(c, home, away, date)
            if not meta:
                return _out({"ok": False, "error": "match not found", "type": "resolve"})
            return _out({"ok": True, "type": "resolve", "data": meta})

        if action == "team_history" or "team_id" in payload:
            tid = payload.get("team_id")
            if not tid:
                return _out({"ok": False, "error": "team_id required"})
            return _out({
                "ok": True,
                "type": "team_history",
                "data": c.team_history(tid, n=int(payload.get("n", 10))),
            })

        if action == "standings" or "comp_id" in payload:
            cid = payload.get("comp_id")
            if not cid:
                return _out({"ok": False, "error": "comp_id required"})
            return _out({
                "ok": True,
                "type": "standings",
                "data": c.standings(cid, season_id=str(payload.get("season_id") or "")),
            })

        return _out({
            "ok": False,
            "error": "unrecognized payload; action one of scout|advanced|tables|lineups|history|live_result|day_card|matches_date|odds|resolve|team_history|standings|status",
        })

    except AiscoreError as e:
        return _out({"ok": False, "error": str(e), "type": action or None})
    except Exception as e:
        return _out({"ok": False, "error": f"{type(e).__name__}: {e}", "type": action or None})


if __name__ == "__main__":
    raise SystemExit(main())
