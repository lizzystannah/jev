"""Motor probabilistico local — substitui o Jev (OpenRouter/TypeSafe).

Usa TODAS as variaveis retornadas pelo AiScore (match/history):
  - Por jogo (home/away/h2h lists): id, date/matchTime, home_id/home, away_id/away,
    ft_home/ft_away (homeScores/awayScores packed sint32 [FT,1H,2H,ET1,ET2,Pens]),
    ht_home/ht_away, periods_home/away, statusId/matchStatus/finished,
    result W/D/L, gf/ga, side home/away, comp, roundNum
  - Agregados last10/all: W/D/L, GF/GA, avg_gf/ga/total, over15/25/35, btts,
    clean_sheets, failed_to_score, avg_1h_goals, venue split, form_last5/10, totals
  - Trends (home/away + _sc): matches, win/draw/loss, goals/conceded,
    avgPossession, avgShots, winStreak, unbeatenRun, overGoals+overGoalsDots,
    bothScore+bothScoreDots, underCards+Dots, underCorners+Dots
  - GoalDistributions (all/home/away): matches, scored[6 janelas],
    conceded[6], scored_by_window, conceded_by_window, scored_total/conceded_total
  - H2H: n_finished, over15/25/35, btts, clean_sheets_focal, focal_wdl,
    unbeaten_run_longest + span, lista focal completa
  - Meta: competition, kickoff, statusId (+ standings opcional: position/points)
  - Odds de mercado: so para EV (prob*odd-1) e escolha do mercado — nunca como
    unica fonte de probabilidade.

Saida por partida: probs por mercado (0..1), xG, mercado recomendado, prob
calibrada 0..100, edge EV%, riskTier, confidence, explicacao variavel a variavel.

Uso:
  from motor_aiscore import evaluate_match
  ev = evaluate_match(scout_dict, odds_dict, advanced_dict=None, standings=None)
  # scout_dict = batch_scout.scout_one(...) ; odds_dict = {"home":..,"draw":..,...}
  # advanced_dict = {"goal_distributions":[...], "home_trend_sc":..., ...} (opcional;
  #   o scout ja traz home_trend/away_trend + goal windows via advanced_stats_*.json)

Deterministico: mesma entrada -> mesma saida. Sem rede, sem chave, sem LLM.
"""
from __future__ import annotations

import math

WINDOWS = ["0-15", "16-30", "31-45", "46-60", "61-75", "76-90+"]

MODEL_VERSION = "local/aiscore-engine-v1"

# ---------------------------------------------------------------- helpers ---

def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _safe_avg(vals: list, default: float = 0.0) -> float:
    vals = [v for v in vals if isinstance(v, (int, float))]
    return sum(vals) / len(vals) if vals else default


def _form_points(form: str) -> tuple[float, int]:
    """'WDDLL' -> (pts/ultimos ponderados, n). Recentes pesam mais."""
    if not form:
        return 0.0, 0
    w = {"W": 3.0, "D": 1.0, "L": 0.0}
    tot = 0.0
    pw = 0.0
    for i, ch in enumerate(reversed(form.strip().upper())):  # i=0 mais recente
        decay = 1.0 / (1.0 + 0.25 * i)
        tot += w.get(ch, 0.0) * decay
        pw += 3.0 * decay
    return (tot / pw) if pw else 0.0, len(form)


def _streak_bonus(form: str) -> float:
    """Bonus/penalidade pelo momento: + por vitoria/empate recente, - por derrota."""
    if not form:
        return 0.0
    f = form.strip().upper()
    last = f[-3:] if len(f) >= 3 else f
    score = sum({"W": 1.0, "D": 0.3, "L": -0.7}.get(c, 0.0) for c in last)
    return _clamp(score / 3.0, -1.0, 1.0) * 0.12  # +-12% max no xG relativo


def poisson_matrix(lam_h: float, lam_a: float, max_g: int = 8) -> list[list[float]]:
    def pmf(lam: float, k: int) -> float:
        return math.exp(-lam) * lam ** k / math.factorial(k)
    return [[pmf(lam_h, i) * pmf(lam_a, j) for j in range(max_g + 1)]
            for i in range(max_g + 1)]


def _poisson_markets(lam_h: float, lam_a: float) -> dict:
    m = poisson_matrix(lam_h, lam_a)
    p_home = p_draw = p_away = 0.0
    p_o15 = p_o25 = p_o35 = 0.0
    p_btts = 0.0
    for i, row in enumerate(m):
        for j, p in enumerate(row):
            tot = i + j
            if i > j:
                p_home += p
            elif i == j:
                p_draw += p
            else:
                p_away += p
            if tot >= 2:
                p_o15 += p
            if tot >= 3:
                p_o25 += p
            if tot >= 4:
                p_o35 += p
            if i > 0 and j > 0:
                p_btts += p
    return {"home": p_home, "draw": p_draw, "away": p_away,
            "over15": p_o15, "over25": p_o25, "over35": p_o35,
            "under25": 1 - p_o25, "under35": 1 - p_o35,
            "btts_yes": p_btts, "btts_no": 1 - p_btts}


# ------------------------------------------------------- extracao de sinais ---

def _derive_from_matches(matches: list, venue_side: str) -> dict:
    """Deriva taxas da lista de jogos (scout_one nao traz over25/btts/
    clean-sheets/GF-GA-de-mando agregados — aqui nada é inventado, é a
    mesma fonte: os ~10 jogos finalizados com ft/ht/gf/ga/side)."""
    fin = [r for r in (matches or []) if r and r.get("finished")
           and r.get("ft_home") is not None and r.get("ft_away") is not None]
    n = len(fin)
    totals = [(r.get("ft_home") or 0) + (r.get("ft_away") or 0) for r in fin]
    ht = [(r["ht_home"] + r["ht_away"]) for r in fin
          if r.get("ht_home") is not None and r.get("ht_away") is not None]
    v = [r for r in fin if r.get("side") == venue_side]
    return {
        "n": n,
        "over25_rate": sum(1 for t in totals if t >= 3) / max(1, n),
        "btts_rate": sum(1 for r in fin if (r.get("ft_home") or 0) > 0
                         and (r.get("ft_away") or 0) > 0) / max(1, n),
        "clean_sheets": sum(1 for r in fin if (r.get("ga") or 0) == 0),
        "failed_to_score": sum(1 for r in fin if (r.get("gf") or 0) == 0),
        "avg_1h": sum(ht) / len(ht) if ht else None,
        "venue_n": len(v),
        "venue_gf": sum(r.get("gf") or 0 for r in v),
        "venue_ga": sum(r.get("ga") or 0 for r in v),
        "venue_w": sum(1 for r in v if r.get("result") == "W"),
        "venue_d": sum(1 for r in v if r.get("result") == "D"),
        "venue_l": sum(1 for r in v if r.get("result") == "L"),
    }


def _team_block(form: dict, trend: dict | None, side_venue: str,
                adv_last10: dict | None = None) -> dict:
    """Condensa form(last10)+trend+venue de UM lado.

    Precedência: advanced team_stats last10 (mais rico) > agregados do form >
    derivado da lista de jogos. `side_venue`: 'home' p/ mandante em casa,
    'away' p/ visitante fora (vantagem de mando real).
    """
    form = form or {}
    trend = trend or {}
    A = adv_last10 or {}
    n = form.get("n") or A.get("n") or trend.get("matches") or 0
    der = _derive_from_matches(form.get("matches") or A.get("matches"), side_venue)

    def agg_rate(key):
        for src in (A.get(key), form.get(key)):
            if isinstance(src, dict) and src.get("n"):
                return src.get("count", 0) / src["n"]
        return None

    over25_rate = agg_rate("over25")
    if over25_rate is None:
        over25_rate = der["over25_rate"]
    btts_rate = agg_rate("btts")
    if btts_rate is None:
        btts_rate = der["btts_rate"]

    v_adv = (A.get("venue") or {}).get(side_venue) or {}
    v_sco = form.get(side_venue) or {}
    venue_n = v_adv.get("n") or v_sco.get("n") or der["venue_n"] or 0
    venue_gf = v_adv.get("GF")
    if venue_gf is None:
        venue_gf = der["venue_gf"]
    venue_ga = v_adv.get("GA")
    if venue_ga is None:
        venue_ga = der["venue_ga"]

    cs = A.get("clean_sheets", form.get("clean_sheets"))
    if cs is None:
        cs = der["clean_sheets"]
    fts = A.get("failed_to_score", form.get("failed_to_score"))
    if fts is None:
        fts = der["failed_to_score"]
    avg1h = A.get("avg_1h_goals", form.get("avg_1h_goals"))
    if avg1h is None:
        avg1h = der["avg_1h"]
    # WDL de mando: advanced venue traz; senao deriva dos jogos do mando.
    vw = v_adv.get("W", v_sco.get("W", der["venue_w"]))
    vd = v_adv.get("D", v_sco.get("D", der["venue_d"]))
    vl = v_adv.get("L", v_sco.get("L", der["venue_l"]))
    return {
        "n": n,
        "W": A.get("W", form.get("W", 0)), "D": A.get("D", form.get("D", 0)),
        "L": A.get("L", form.get("L", 0)),
        "GF": A.get("GF", form.get("GF", 0)), "GA": A.get("GA", form.get("GA", 0)),
        "form": A.get("form_last10", form.get("form", "")),
        "venue_n": venue_n,
        "venue_gf": venue_gf,
        "venue_ga": venue_ga,
        "venue_w": vw or 0, "venue_d": vd or 0, "venue_l": vl or 0,
        "avg_total": ((A.get("GF", form.get("GF", 0)) + A.get("GA", form.get("GA", 0)))
                      / max(1, n)) if n else 0.0,
        "avg_1h": avg1h,
        "clean_sheets": cs,
        "failed_to_score": fts,
        "over25_rate": over25_rate,
        "btts_rate": btts_rate,
        "poss": trend.get("avgPossession"),
        "shots": float(trend.get("avgShots") or 0) if trend.get("avgShots") else 0.0,
        "win_streak": trend.get("winStreak", 0) or 0,
        "unbeaten": trend.get("unbeatenRun", 0) or 0,
        "team_over25_n": trend.get("overGoals", 0) or 0,  # 3+ do proprio time
        "btts_n": trend.get("bothScore", 0) or 0,
        "under_cards": trend.get("underCards", 0) or 0,
        "under_corners": trend.get("underCorners", 0) or 0,
        "trend_matches": trend.get("matches", 0) or 0,
    }


def _h2h_block(scout: dict, h2h_stats: dict | None) -> dict:
    h2h = scout.get("h2h") or []
    fin = [r for r in h2h if r and r.get("finished")]
    summ = scout.get("h2h_summary") or {}
    n = len(fin)
    totals = [(r.get("ft_home") or 0) + (r.get("ft_away") or 0) for r in fin]
    btts = sum(1 for r in fin if (r.get("ft_home") or 0) > 0 and (r.get("ft_away") or 0) > 0)
    # recencia: ultimos 3 pesam 2x
    recent = fin[:3] if fin else []
    rec_tot = _safe_avg([(r.get("ft_home") or 0) + (r.get("ft_away") or 0) for r in recent],
                        _safe_avg(totals, 2.5))
    hs = h2h_stats or {}
    over25 = ((hs.get("over25") or {}).get("count", 0) / max(1, (hs.get("over25") or {}).get("n", n) or 1)) if hs else (
        sum(1 for t in totals if t >= 3) / max(1, n))
    return {
        "n": n,
        "W": summ.get("W", 0), "D": summ.get("D", 0), "L": summ.get("L", 0),
        "avg_total": _safe_avg(totals, 2.5),
        "recent_avg_total": rec_tot,
        "over25_rate": over25,
        "btts_rate": (btts / max(1, n)),
        "unbeaten_longest": (hs.get("focal_unbeaten_run_longest") or 0),
        "fin": fin,
    }


def _goals_window_factor(goal_distributions: list, home_id, away_id) -> dict:
    """Janelas 0-15..76-90+: concentracao de gol tardio => leve boost over/BTTS."""
    late_scored = late_conc = tot_sc = tot_co = 0
    for gd in goal_distributions or []:
        if gd.get("team_id") not in (home_id, away_id):
            continue
        for side in ("all",):
            it = gd.get(side) or {}
            sbw = it.get("scored_by_window") or {}
            cbw = it.get("conceded_by_window") or {}
            late_scored += (sbw.get("61-75") or 0) + (sbw.get("76-90+") or 0)
            late_conc += (cbw.get("61-75") or 0) + (cbw.get("76-90+") or 0)
            tot_sc += it.get("scored_total") or 0
            tot_co += it.get("conceded_total") or 0
    late_share = ((late_scored + late_conc) / max(1, tot_sc + tot_co))
    if tot_sc + tot_co == 0:
        return {"late_share": 0.0, "over_boost": 0.0}  # sem dados: neutro
    return {"late_share": late_share,
            "over_boost": _clamp((late_share - 0.30) * 0.25, -0.03, 0.05)}


# ----------------------------------------------------------------- motor ---

def _table_rows(tables) -> list:
    """Normaliza tabelas: bridge {"tables":[{rows}]} ou lista plana de rows."""
    if isinstance(tables, dict):
        tables = tables.get("tables") or tables.get("rows") or []
    if not isinstance(tables, list):
        return []
    rows = []
    for t in tables:
        if isinstance(t, dict) and isinstance(t.get("rows"), list):
            rows.extend(t["rows"])
        elif isinstance(t, dict) and t.get("team_id"):
            rows.append(t)
    return [r for r in rows if isinstance(r, dict)]


def _lineup_side(lineups, side: str) -> dict:
    L = lineups or {}
    blk = L.get(side) or {}
    return {
        "avg_rating": blk.get("avg_rating"),
        "captain_in_xi": blk.get("captain_in_xi", True),
        "starters": blk.get("starters", 0),
        "unavailable": blk.get("unavailable") or [],
    }


def estimate_xg(scout: dict, advanced: dict | None = None,
                tables=None, lineups=None, context=None) -> dict:
    """xG esperado do confronto a partir de TODAS as variaveis AiScore.

    tables: bridge {"tables":[{table,group,rows}]} ou lista de rows
      (position/points/total/goals/goalDiff por team_id).
    lineups: bridge {"available", "confirmed", home/away:
      {avg_rating, captain_in_xi, starters, unavailable[]}}.
    context: {"restDaysHome", "restDaysAway", "importance"}.
    Parâmetros também aceites dentro de `advanced` (mesmas chaves).
    """
    hf = scout.get("home_form") or {}
    af = scout.get("away_form") or {}
    ht = scout.get("home_trend") or {}
    at = scout.get("away_trend") or {}
    hts = (advanced or {}).get("home_trend_sc") or scout.get("home_trend_sc") or {}
    ats = (advanced or {}).get("away_trend_sc") or scout.get("away_trend_sc") or {}
    gds = (advanced or {}).get("goal_distributions") or scout.get("goal_distributions") or []
    adv = advanced or {}
    hs = adv.get("home_stats") or (adv.get("home") or {}).get("stats") or {}
    as_ = adv.get("away_stats") or (adv.get("away") or {}).get("stats") or {}
    h2h_stats = adv.get("h2h_stats") or adv.get("h2h") or scout.get("h2h_stats")
    tables = tables if tables is not None else adv.get("tables")
    lineups = lineups if lineups is not None else adv.get("lineups")
    context = context if context is not None else adv.get("context")

    home_id = scout.get("home", {}).get("id") or scout.get("home_team_id")
    away_id = scout.get("away", {}).get("id") or scout.get("away_team_id")

    H = _team_block(hf, ht, "home", (hs or {}).get("last10"))   # mandante em casa
    A = _team_block(af, at, "away", (as_ or {}).get("last10"))  # visitante fora
    H2 = _h2h_block(scout, h2h_stats)
    WF = _goals_window_factor(gds, home_id, away_id)

    # ataque/defesa por jogo com peso de mando (venue 55% + geral 45%)
    def per_game(blk):
        n = max(1, blk["n"] or 1)
        if blk["venue_n"] and blk["venue_n"] >= 2:
            gf = 0.55 * (blk["venue_gf"] / blk["venue_n"]) + 0.45 * (blk["GF"] / n)
            ga = 0.55 * (blk["venue_ga"] / blk["venue_n"]) + 0.45 * (blk["GA"] / n)
        else:
            gf, ga = blk["GF"] / n, blk["GA"] / n
        return gf, ga

    h_gf, h_ga = per_game(H)
    a_gf, a_ga = per_game(A)

    # base: media do ataque de um com a defesa do outro
    xg_h = (h_gf + a_ga) / 2.0
    xg_a = (a_gf + h_ga) / 2.0

    # H2H puxa 15% para a media historica do confronto
    if H2["n"] >= 2:
        half = H2["recent_avg_total"] / 2.0
        xg_h = 0.85 * xg_h + 0.15 * half
        xg_a = 0.85 * xg_a + 0.15 * half

    # momento (forma ponderada + streak/unbeaten)
    _, _ = _form_points(H["form"]), _form_points(A["form"])
    mom_h = _streak_bonus(H["form"]) + min(0.06, 0.02 * (H["unbeaten"] or 0))
    mom_a = _streak_bonus(A["form"]) + min(0.06, 0.02 * (A["unbeaten"] or 0))
    xg_h *= (1 + mom_h)
    xg_a *= (1 + mom_a)

    # posses/chutes: diferencial de volume ofensivo (+-8% max)
    shot_edge = _clamp(((H["shots"] or 0) - (A["shots"] or 0)) / 10.0, -0.08, 0.08)
    xg_h *= (1 + shot_edge)
    xg_a *= (1 - shot_edge)

    # mando de campo base +3% (ja parcialmente no venue; mantem resíduo pequeno)
    xg_h *= 1.03

    notes = []
    # vitorias em casa/fora: aproveitamento no mando vs geral (+-5% max)
    for blk, key, tag in ((H, "xg_h", "home"), (A, "xg_a", "away")):
        vn, n = max(1, blk["venue_n"] or 0), max(1, blk["n"] or 1)
        vwr = (blk["venue_w"] or 0) / vn if blk["venue_n"] else None
        owr = (blk["W"] or 0) / n
        if vwr is not None and blk["venue_n"] >= 2:
            edge = _clamp((vwr - owr) * 0.3, -0.05, 0.05)
            if tag == "home":
                xg_h *= (1 + edge)
            else:
                xg_a *= (1 + edge)
            notes.append(f"venueWDL {tag} {edge:+.1%}")

    # classificacao: PPG + saldo/de-jogo do grupo (vale p/ grupos e ligas)
    trows = _table_rows(tables)
    if trows:
        by_id = {r.get("team_id"): r for r in trows if r.get("team_id")}

        def strength(r):
            defni = lambda v, d=0: (
                float(v) if isinstance(v, (int, float)) or
                (isinstance(v, str) and v.replace(".", "", 1).lstrip("-").isdigit())
                else d)
            tot = defni(r.get("total"))
            if not tot or tot < 3 or r.get("points") is None:
                return None
            gd = defni(r.get("goalDiff"))
            return (defni(r.get("points")) / tot) / 3 * 0.7 + _clamp((gd / tot) / 2, -1, 1) * 0.3

        rh, ra = by_id.get(home_id), by_id.get(away_id)
        sh, sa = strength(rh) if rh else None, strength(ra) if ra else None
        if sh is not None and sa is not None:
            adj = _clamp((sh - sa) * 0.12, -0.06, 0.06)
            xg_h *= (1 + adj)
            xg_a *= (1 - adj)
            same = (rh.get("group") == ra.get("group") and
                    rh.get("table_id") == ra.get("table_id"))
            pos = ""
            if same and rh.get("position") and ra.get("position"):
                pos = f" pos {rh['position']}v{ra['position']}"
            notes.append(f"tables{pos} PPG {rh.get('points')}/{rh.get('total')}v"
                         f"{ra.get('points')}/{ra.get('total')} adj {adj:+.2%}")

    # escalacoes: nota dos titulares, capitao e desfalques
    lin_note = None
    if isinstance(lineups, dict) and lineups.get("available"):
        lh, la = _lineup_side(lineups, "home"), _lineup_side(lineups, "away")
        rh, ra = lh["avg_rating"], la["avg_rating"]
        if isinstance(rh, (int, float)) and isinstance(ra, (int, float)):
            redge = _clamp((rh - ra) * 0.04, -0.04, 0.04)
            xg_h *= (1 + redge)
            xg_a *= (1 - redge)
            lin_note = f"ratings {rh}v{ra}"
        if not lh["captain_in_xi"] and lh["starters"] >= 11:
            xg_h *= 0.98
            lin_note = (lin_note + " " if lin_note else "") + "capitao casa fora"
        if not la["captain_in_xi"] and la["starters"] >= 11:
            xg_a *= 0.98
            lin_note = (lin_note + " " if lin_note else "") + "capitao fora fora"
        uh, ua = len(lh["unavailable"]), len(la["unavailable"])

        def _pos_hit(unav_list):
            """Peso por posição: F/M desfalcado tira golos próprios;
            D/G desfalcado dá golos ao adversário."""
            own, opp = 0.0, 0.0
            for u in unav_list or []:
                pos = (u.get("position") or "").upper()
                if pos == "F":
                    own += 0.03
                elif pos == "M":
                    own += 0.02
                elif pos == "D":
                    opp += 0.025
                elif pos == "G":
                    opp += 0.04
                else:
                    own += 0.02
            return min(0.10, own), min(0.10, opp)

        own_h, opp_h = _pos_hit(lh["unavailable"])
        own_a, opp_a = _pos_hit(la["unavailable"])
        if own_h or opp_a:
            xg_h *= (1 - own_h) * (1 + opp_a)
        if own_a or opp_h:
            xg_a *= (1 - own_a) * (1 + opp_h)
        if uh or ua:
            det_h = "+".join(
                f"{p or '?'}" for p in
                [(u.get("position") or "?") for u in lh["unavailable"]])
            det_a = "+".join(
                f"{p or '?'}" for p in
                [(u.get("position") or "?") for u in la["unavailable"]])
            lin_note = (lin_note + " " if lin_note else "") + f"desfalques {det_h}v{det_a}"
        if lineups.get("confirmed") != 1:
            lin_note = (lin_note + " " if lin_note else "") + "escalacao nao confirmada"
        if lin_note:
            notes.append("lineups " + lin_note)

    # descanso: diferença de dias desde o último jogo (+-4% max)
    if isinstance(context, dict):
        rh, ra = context.get("restDaysHome"), context.get("restDaysAway")
        if isinstance(rh, (int, float)) and isinstance(ra, (int, float)):
            diff = rh - ra  # + => casa mais descansada
            adj = _clamp(diff * 0.008, -0.04, 0.04)
            xg_h *= (1 + adj)
            xg_a *= (1 - adj)
            notes.append(f"descanso {rh}v{ra}d adj {adj:+.2%}")

    # segunda amostra _sc (contexto alternativo) como regularizador suave
    for sc, blk, key in ((hts, H, "h"), (ats, A, "a")):
        if sc and sc.get("matches"):
            try:
                sc_gf = sc["goals"] / sc["matches"]
                sc_ga = sc["conceded"] / sc["matches"]
                if key == "h":
                    xg_h = 0.9 * xg_h + 0.1 * (sc_gf + a_ga) / 2
                else:
                    xg_a = 0.9 * xg_a + 0.1 * (sc_gf + h_ga) / 2
            except (KeyError, TypeError, ZeroDivisionError):
                pass

    xg_h = _clamp(xg_h, 0.05, 4.5)
    xg_a = _clamp(xg_a, 0.05, 4.5)

    return {"xg_home": round(xg_h, 3), "xg_away": round(xg_a, 3),
            "H": H, "A": A, "H2": H2, "WF": WF,
            "h_gf": h_gf, "h_ga": h_ga, "a_gf": a_gf, "a_ga": a_ga,
            "notes": notes,
            "tables_used": bool(trows),
            "lineups_used": bool(isinstance(lineups, dict) and lineups.get("available"))}


def market_probabilities(scout: dict, advanced: dict | None = None,
                         tables=None, lineups=None, context=None) -> dict:
    """Probabilidades 0..1 por mercado fundindo Poisson + taxas empiricas."""
    x = estimate_xg(scout, advanced, tables, lineups, context)
    context = context if context is not None else (advanced or {}).get("context")
    H, A, H2, WF = x["H"], x["A"], x["H2"], x["WF"]
    pois = _poisson_markets(x["xg_home"], x["xg_away"])

    emp_o25 = _safe_avg([H["over25_rate"], A["over25_rate"]], 0.5)
    emp_btts = _safe_avg([H["btts_rate"], A["btts_rate"]], 0.5)
    emp_o15 = _clamp(emp_o25 * 1.45, 0, 0.97)

    h2h_o25 = H2["over25_rate"]
    h2h_btts = H2["btts_rate"]
    h2h_w = min(0.12, 0.03 * H2["n"])  # H2H pesa ate 12%

    # ritmo de 1a parte: media de golos HT dos dois + ajuste no over
    ht_note = None
    ht_adj = 0.0
    if isinstance(H.get("avg_1h"), (int, float)) and isinstance(A.get("avg_1h"), (int, float)):
        ht_adj = _clamp(((H["avg_1h"] + A["avg_1h"]) - 1.1) * 0.05, -0.03, 0.03)
        ht_note = f"HT {H['avg_1h']:.2f}+{A['avg_1h']:.2f} adj {ht_adj:+.3f}"

    # underCards/ underCorners do trend: contexto (nao viram mercado direto aqui,
    # mas ajustam confianca de jogo travado => under)
    under_game = _safe_avg([min(1.0, (H["under_cards"] + H["under_corners"]) / 20.0),
                            min(1.0, (A["under_cards"] + A["under_corners"]) / 20.0)], 0.5)

    p_o25 = _clamp(0.60 * pois["over25"] + 0.28 * emp_o25 + h2h_w * h2h_o25 + WF["over_boost"] + ht_adj, 0.02, 0.97)
    p_o15 = _clamp(0.60 * pois["over15"] + 0.28 * emp_o15 + h2h_w * h2h_o25, 0.05, 0.98)
    p_o35 = _clamp(0.65 * pois["over35"] + 0.25 * _clamp(emp_o25 * 0.55, 0, 1) + h2h_w * h2h_o25 * 0.5, 0.01, 0.9)
    p_btts = _clamp(0.60 * pois["btts_yes"] + 0.28 * emp_btts + h2h_w * h2h_btts, 0.02, 0.95)

    # clean sheets / failed_to_score derrubam BTTS de forma explicita
    cs_rate = ((H["clean_sheets"] + A["clean_sheets"]) / max(2, (H["n"] or 0) + (A["n"] or 0)))
    fts_rate = ((H["failed_to_score"] + A["failed_to_score"]) / max(2, (H["n"] or 0) + (A["n"] or 0)))
    p_btts *= (1 - 0.5 * cs_rate)
    p_btts *= (1 - 0.4 * fts_rate)
    p_btts = _clamp(p_btts, 0.02, 0.95)

    # 1X2: Poisson + forma (pontos ponderados) + H2H focal + shots
    pf_h, _ = _form_points(H["form"])
    pf_a, _ = _form_points(A["form"])
    form_edge = _clamp((pf_h - pf_a) * 0.35, -0.12, 0.12)
    h2h_edge = 0.0
    tot_h2 = (H2["W"] + H2["D"] + H2["L"]) or 0
    if tot_h2 >= 2:
        h2h_edge = _clamp(((H2["W"] + 0.5 * H2["D"]) / tot_h2 - 0.5) * 0.5, -0.10, 0.10)
    # sequencia invicta no confronto direto reforca o mandante focal
    unbeaten_bonus = 0.0
    longest = (H2.get("unbeaten_longest") or 0)
    if longest >= 3 and tot_h2 >= 2:
        unbeaten_bonus = min(0.05, 0.015 * (longest - 2))
        h2h_edge = _clamp(h2h_edge + unbeaten_bonus, -0.10, 0.10)

    p_h = _clamp(pois["home"] * (1 + form_edge + h2h_edge), 0.02, 0.93)
    p_a = _clamp(pois["away"] * (1 - form_edge - h2h_edge), 0.02, 0.93)
    # re-normaliza 1X2 mantendo o draw de Poisson como ancora
    s = p_h + pois["draw"] + p_a
    p_h, p_d, p_a = p_h / s, pois["draw"] / s, p_a / s

    p_1x = 1 - p_a
    p_x2 = 1 - p_h
    p_12 = 1 - p_d

    out = {"home": p_h, "draw": p_d, "away": p_a,
           "double_chance_1x": p_1x, "double_chance_x2": p_x2, "double_chance_12": p_12,
           "over15": p_o15, "over25": p_o25, "over35": p_o35,
           "under25": 1 - p_o25, "under35": 1 - p_o35,
           "btts_yes": p_btts, "btts_no": 1 - p_btts}
    # DNB aprox: vitoria / (vitoria + empate)
    out["dnb_home"] = _clamp(p_h / max(0.05, p_h + p_d), 0.05, 0.97)
    out["dnb_away"] = _clamp(p_a / max(0.05, p_a + p_d), 0.05, 0.97)

    # jogo travado (cards/corners under altos + 1H pobre) reforca unders
    if under_game > 0.85:
        out["under35"] = _clamp(out["under35"] + 0.02, 0, 0.98)
        out["under25"] = _clamp(out["under25"] + 0.015, 0, 0.97)

    # importancia: classico/decisao tende a jogo fechado
    imp = (context or {}).get("importance") if isinstance(context, dict) else None
    if imp in ("derby", "decisiva"):
        out["under25"] = _clamp(out["under25"] + 0.02, 0, 0.97)
        out["under35"] = _clamp(out["under35"] + 0.02, 0, 0.98)
        out["over25"] = _clamp(out["over25"] - 0.02, 0.02, 0.97)
        out["btts_yes"] = _clamp(out["btts_yes"] - 0.015, 0.02, 0.95)
        out["btts_no"] = 1 - out["btts_yes"]

    return {"probs": out, "xg": x, "emp": {"emp_o25": emp_o25, "emp_btts": emp_btts,
                                           "h2h_o25": h2h_o25, "h2h_btts": h2h_btts,
                                           "form_edge": form_edge, "h2h_edge": h2h_edge,
                                           "unbeaten_bonus": unbeaten_bonus,
                                           "ht_adj": ht_adj, "ht_note": ht_note,
                                           "under_game": under_game}}


MARKET_LABELS_PT = {
    "home": "Vitoria casa", "draw": "Empate", "away": "Vitoria fora",
    "double_chance_1x": "Dupla chance 1X", "double_chance_x2": "Dupla chance X2",
    "double_chance_12": "Dupla chance 12",
    "over15": "Mais de 1.5 golos", "over25": "Mais de 2.5 golos",
    "over35": "Mais de 3.5 golos", "under25": "Menos de 2.5 golos",
    "under35": "Menos de 3.5 golos",
    "btts_yes": "Ambas marcam (Sim)", "btts_no": "Ambas marcam (Nao)",
    "dnb_home": "Empate anula (casa)", "dnb_away": "Empate anula (fora)",
}


def _sanitize_odd(v, fallback=1.85) -> float:
    try:
        f = float(v)
        if math.isfinite(f) and f > 1.01:
            return round(f, 2)
    except (TypeError, ValueError):
        pass
    return fallback


def evaluate_match(scout: dict, odds: dict | None = None,
                   advanced: dict | None = None,
                   tables=None, lineups=None, context=None) -> dict:
    """Avalia UMA partida. Retorna shape compativel com o antigo JevEvaluatedMatch."""
    mp = market_probabilities(scout, advanced, tables, lineups, context)
    probs: dict = mp["probs"]
    xg = mp["xg"]
    odds = odds or {}
    full_odds = {m: _sanitize_odd(odds.get(m)) for m in probs}

    # amostra: confianca cai com poucos jogos; escalacao por confirmar tira 5pp
    n_total = (xg["H"]["n"] or 0) + (xg["A"]["n"] or 0) + (xg["H2"]["n"] or 0)
    confidence = _clamp(0.55 + min(20, n_total) / 20 * 0.35
                        + (0.05 if (xg["H"]["trend_matches"] or 0) >= 8 else 0), 0.10, 0.95)
    lin = lineups if lineups is not None else (advanced or {}).get("lineups")
    if isinstance(lin, dict) and lin.get("available") and lin.get("confirmed") != 1:
        confidence = _clamp(confidence - 0.05, 0.10, 0.95)

    # escolhe mercado: maior EV entre probs >= piso; desempate por prob
    cands = []
    for m, p in probs.items():
        odd = full_odds[m]
        edge = p * odd - 1  # fracao (0.10 = +10%)
        floor = 0.45 if m in ("double_chance_1x", "double_chance_x2", "over15", "under35") else 0.50
        cands.append((edge if p >= floor else edge - 1.0, p, m, odd, edge))
    cands.sort(reverse=True)
    _, best_p, best_m, best_odd, best_edge = cands[0]

    calib = int(round(_clamp(best_p, 0.10, 0.95) * 100))
    tier = "segura" if calib >= 63 else ("moderada" if calib >= 48 else "ousada")

    home = (scout.get("home") or {}).get("name") or scout.get("home_team")
    away = (scout.get("away") or {}).get("name") or scout.get("away_team")
    exp = {
        "home": (scout.get("home") or {}).get("name"),
        "away": (scout.get("away") or {}).get("name"),
        "competition": scout.get("competition"),
        "xg_home": xg["xg_home"], "xg_away": xg["xg_away"],
        "h2h_n": xg["H2"]["n"],
        "h2h_summary": {"W": xg["H2"]["W"], "D": xg["H2"]["D"], "L": xg["H2"]["L"]},
        "home_last10": f"W{xg['H']['W']}-D{xg['H']['D']}-L{xg['H']['L']} GF{xg['H']['GF']} GA{xg['H']['GA']}",
        "away_last10": f"W{xg['A']['W']}-D{xg['A']['D']}-L{xg['A']['L']} GF{xg['A']['GF']} GA{xg['A']['GA']}",
        "late_goals_share": round(xg["WF"]["late_share"], 3),
        "form_edge": round(mp["emp"]["form_edge"], 3),
        "h2h_edge": round(mp["emp"]["h2h_edge"], 3),
        "unbeaten_bonus": round(mp["emp"].get("unbeaten_bonus", 0), 3),
        "ht_note": mp["emp"].get("ht_note"),
        "notes": xg.get("notes") or [],
        "tables_used": xg.get("tables_used", False),
        "lineups_used": xg.get("lineups_used", False),
    }

    return {
        "matchId": scout.get("match_id"),
        "calibratedProb": calib,
        "expectedValueEdge": round(best_edge * 100, 1),
        "recommendedMarket": best_m,
        "marketLabel": MARKET_LABELS_PT.get(best_m, best_m),
        "selectedOdds": best_odd,
        "riskTier": tier,
        "confidence": round(confidence, 3),
        "localScore": int(round(calib * 0.7 + max(0, best_edge * 100) * 1.2)),
        "probs": {k: round(v, 4) for k, v in probs.items()},
        "odds_used": full_odds,
        "xg_home": xg["xg_home"], "xg_away": xg["xg_away"],
        "explain": exp,
        "home": home, "away": away,
        "modelVersion": MODEL_VERSION,
    }


def evaluate_report(report: dict, odds_by_match: dict | None = None,
                    advanced_by_match: dict | None = None) -> list[dict]:
    """Avalia um scout_report_{date}.json inteiro."""
    odds_by_match = odds_by_match or {}
    advanced_by_match = advanced_by_match or {}
    out = []
    for m in report.get("matches", []):
        mid = m.get("match_id")
        out.append(evaluate_match(m, odds_by_match.get(mid),
                                  advanced_by_match.get(mid)))
    return out


if __name__ == "__main__":
    import json
    import sys
    from pathlib import Path

    # demo offline: python motor_aiscore.py scout/j374oi04xwnhgqo.json
    p = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("scout/j374oi04xwnhgqo.json")
    scout = json.loads(p.read_text(encoding="utf-8"))
    adv = None
    for cand in (Path("advanced_stats_finished.json"), Path("advanced_stats_future.json")):
        if cand.exists():
            try:
                adv_all = json.loads(cand.read_text(encoding="utf-8"))
                # encontra entrada do mesmo confronto
                if adv_all.get("home_team_id") in (
                        (scout.get("home") or {}).get("id"), (scout.get("away") or {}).get("id")):
                    adv = adv_all
                    break
            except Exception:
                pass
    ev = evaluate_match(scout, odds=None, advanced=adv)
    print(json.dumps(ev, ensure_ascii=False, indent=2))
