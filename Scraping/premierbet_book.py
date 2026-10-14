"""Monta uma ficha no premierbet.co.ao a partir de um BetSlip nosso.

Fluxo (SEM login, SEM apostar — só deixa a ficha pronta no boletim):
  1. Para cada perna: localiza o jogo na API da Premier Bet
     (events/upcoming por data + fuzzy de nomes) e lê events/{id}
     (mercados, outcomes, odds).
  2. Mapeia o nosso mercado (home/draw/away/double_chance_*/over*/under*/btts_*/dnb_*)
     para {marketId, outcomeId} da Premier Bet.
  3. Abre o site num browser, injeta as seleções no localStorage
     (chave sah_ao-betslip — formato capturado do site real), recarrega
     e confirma N seleções + odd total. Screenshot de prova.
  4. Tenta o botão Partilhar e devolve o link, se existir.

Uso:
  .\\.venv312\\Scripts\\python.exe -X utf8 Scraping\\premierbet_book.py --slip slip.json
  .\\.venv312\\Scripts\\python.exe -X utf8 Scraping\\premierbet_book.py --slip slip.json --stake 1000 --headful

slip.json: {"id": "...", "legs": [{"home": "...", "away": "...", "league": "...",
  "kickoffAt": 123..., "tip": {"market": "double_chance_1x", "odds": 1.35}}]}
stake em cêntimos de Kz (1000 = Kz 10,00). Nada é apostado.
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone, timedelta
from pathlib import Path

BASE = "https://sports-api.premierbet.co.ao/v1"
SITE = "https://www.premierbet.co.ao"
Q = {"country": "AO", "group": "g2", "platform": "desktop", "locale": "pt"}
HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
    "Origin": SITE,
    "Referer": SITE + "/",
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/131.0.0.0 Safari/537.36"),
}

# Nosso mercado -> (marketId PremierBet, seletor de outcome)
# handicap só para Acima/Abaixo (29). Verificado em evento real.
MARKET_MAP = {
    "home": ("3", lambda o: o.get("name") == "1"),
    "draw": ("3", lambda o: o.get("name") == "X"),
    "away": ("3", lambda o: o.get("name") == "2"),
    "double_chance_1x": ("17", lambda o: o.get("name") == "1X"),
    "double_chance_x2": ("17", lambda o: o.get("name") == "X2"),
    "double_chance_12": ("17", lambda o: o.get("name") == "12"),
    "over15": ("29", lambda o: o.get("name") == "Acima" and o.get("handicap") == "1.5"),
    "over25": ("29", lambda o: o.get("name") == "Acima" and o.get("handicap") == "2.5"),
    "over35": ("29", lambda o: o.get("name") == "Acima" and o.get("handicap") == "3.5"),
    "under25": ("29", lambda o: o.get("name") == "Abaixo" and o.get("handicap") == "2.5"),
    "under35": ("29", lambda o: o.get("name") == "Abaixo" and o.get("handicap") == "3.5"),
    "btts_yes": ("7", lambda o: o.get("name") == "Sim"),
    "btts_no": ("7", lambda o: o.get("name") == "Não"),
    "dnb_home": ("18", lambda o: o.get("name") == "1"),
    "dnb_away": ("18", lambda o: o.get("name") == "2"),
}


def _norm(name: str) -> str:
    s = unicodedata.normalize("NFKD", (name or "").strip().lower())
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"^(fc|cf|sc|ac|cd|sd|ss|as|sk|rc|afc|real|club|deportivo)\s+", "", s)
    s = re.sub(r"\s+(fc|cf|sc|ac|cd|sd|ss|as|sk|rc|afc|cfc|club)$", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _sim(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, _norm(a), _norm(b)).ratio()


class PBClient:
    def __init__(self):
        import curl_cffi.requests as cr
        self.s = cr.Session(impersonate="chrome131")

    def get(self, path: str, **params):
        r = self.s.get(BASE + path, headers=HEADERS,
                       params={**Q, **params}, timeout=25)
        r.raise_for_status()
        return r.json()

    def upcoming(self, date_ymd: str) -> list:
        """Todos os eventos de futebol de um dia (YYYYMMDD)."""
        d = self.get("/events/upcoming", sportId=1, date=date_ymd,
                     timeOffset="-60")
        data = d.get("data") or {}
        out = []
        for cat in data.get("categories") or []:
            for comp in cat.get("competitions") or []:
                for ev in comp.get("matches") or comp.get("events") or []:
                    names = ev.get("eventNames") or []
                    out.append({
                        "id": str(ev.get("id")),
                        "home": names[0] if len(names) > 0 else "",
                        "away": names[1] if len(names) > 1 else "",
                        "start": ev.get("startTime"),
                        "comp": comp.get("name"),
                        "country": cat.get("name"),
                    })
        return out

    def event(self, event_id: str) -> dict:
        return self.get(f"/events/{event_id}")


def find_event(client: PBClient, home: str, away: str, date_ymd: str,
               min_score: float = 0.55) -> dict | None:
    cands = []
    for ev in client.upcoming(date_ymd):
        s = (_sim(home, ev["home"]) + _sim(away, ev["away"])) / 2
        s_rev = (_sim(home, ev["away"]) + _sim(away, ev["home"])) / 2
        if max(s, s_rev) >= min_score:
            cands.append((max(s, s_rev), ev))
    if not cands:
        return None
    cands.sort(key=lambda x: -x[0])
    best, ev = cands[0]
    return {**ev, "match_score": round(best, 3)}


def pick_outcome(ev_detail: dict, our_market: str) -> dict | None:
    if our_market not in MARKET_MAP:
        return None
    mid, want = MARKET_MAP[our_market]
    for g in ev_detail.get("marketGroups") or []:
        for m in g.get("markets") or []:
            if str(m.get("id")) != mid or not m.get("active", True):
                continue
            for o in m.get("outcomes") or []:
                if o.get("active", True) and want(o):
                    return {"market": m, "outcome": o, "group": g.get("name")}
    return None


def to_selection(ev_detail: dict, market: dict, outcome: dict, stake: int = 0) -> dict:
    names = ev_detail.get("eventNames") or []
    return {
        "bet": {"stake": stake},
        "type": "PRE_MATCH",
        "sportId": str(ev_detail.get("sportId", "1")),
        "sportName": ev_detail.get("sportName", "Futebol"),
        "categoryId": str(ev_detail.get("categoryId", "")),
        "categoryName": ev_detail.get("categoryName", ""),
        "competitionId": str(ev_detail.get("competitionId", "")),
        "competitionName": ev_detail.get("competitionName", ""),
        "outcomeValue": str(outcome.get("value")),
        "outcomeName": outcome.get("name"),
        "eventStartTimestamp": ev_detail.get("startTime"),
        "isBetBuilderAvailable": True,
        "eventId": str(ev_detail.get("id")),
        "eventName": f"{names[0]} v {names[1]}" if len(names) > 1 else "",
        "marketTypeRef": str(market.get("id")),
        "marketId": str(market.get("id")),
        "marketName": market.get("name"),
        "outcomeId": str(outcome.get("id")),
        "id": str(outcome.get("id")),
        "isLive": False,
    }


def ymd_of(leg: dict) -> str:
    ts = leg.get("kickoffAt")
    if ts:
        dt = datetime.fromtimestamp(int(ts) / 1000, tz=timezone.utc)
        return (dt + timedelta(hours=1)).strftime("%Y-%m-%d")  # AO = UTC+1
    ds = (leg.get("dateStr") or "")
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", ds)
    if m:
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def build_selections(slip: dict, client: PBClient | None = None) -> dict:
    """Resolve pernas -> seleções Premier Bet (só API, sem browser)."""
    client = client or PBClient()
    selections, report, seen_events = [], [], set()
    for leg in slip.get("legs") or []:
        tip = leg.get("tip") or {}
        market = tip.get("market")
        entry: dict = {"home": leg.get("home"), "away": leg.get("away"),
                       "market": market, "status": ""}
        if market not in MARKET_MAP:
            entry["status"] = f"mercado sem mapa: {market}"
            report.append(entry)
            continue
        ev = find_event(client, leg.get("home") or "", leg.get("away") or "",
                        ymd_of(leg))
        if not ev:
            entry["status"] = "jogo não localizado"
            report.append(entry)
            continue
        if ev["id"] in seen_events:
            entry.update({"event_id": ev["id"], "status": "evento repetido — ignorado"})
            report.append(entry)
            continue
        detail = client.event(ev["id"])
        pick = pick_outcome(detail, market)
        if not pick:
            entry.update({"event_id": ev["id"],
                          "status": "mercado indisponível no evento"})
            report.append(entry)
            continue
        entry.update({
            "event_id": ev["id"],
            "event": f"{ev['home']} v {ev['away']}",
            "pb_market": pick["market"].get("name"),
            "pb_outcome": pick["outcome"].get("name"),
            "pb_odd": pick["outcome"].get("value"),
            "our_odd": tip.get("odds"),
            "status": "ok",
        })
        seen_events.add(ev["id"])
        selections.append(to_selection(detail, pick["market"], pick["outcome"]))
        report.append(entry)
    total = 1.0
    for s in selections:
        try:
            total *= float(s["outcomeValue"])
        except (TypeError, ValueError):
            pass
    return {"slip_id": slip.get("id"), "n_legs": len(selections),
            "total_odds": round(total, 2), "selections": selections,
            "report": report}


def fill_site(selections: list, stake: int = 1000, headful: bool = False,
              shot_path: str | None = None) -> dict:
    """Injeta as seleções no boletim do site e confirma. Não aposta."""
    from playwright.sync_api import sync_playwright
    out: dict = {"filled": 0, "total_odds": None, "share_url": None,
                 "screenshot": shot_path}
    with sync_playwright() as p:
        b = p.chromium.launch(headless=not headful)
        ctx = b.new_context(locale="pt-PT")
        pg = ctx.new_page()
        pg.goto(SITE + "/", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(6000)
        pg.evaluate("""(sels) => {
          const slip = { selections: sels, accaBetStake: STAKE,
            useBonus: false,
            bets: [{ type: sels.length > 1 ? 'MLT' : 'SGL', multiple: 1, stake: STAKE }],
            showMoreMultiples: false, location: 'default', lastSuccessful: 0 };
          localStorage.setItem('sah_ao-betslip', JSON.stringify(slip));
        }""".replace("STAKE", str(int(stake))), selections)
        pg.reload(wait_until="domcontentloaded")
        pg.wait_for_timeout(9000)
        state = pg.evaluate("""() => {
          try {
            const s = JSON.parse(localStorage.getItem('sah_ao-betslip'));
            let tot = 1;
            for (const l of (s.selections || [])) tot *= parseFloat(l.outcomeValue) || 1;
            return { n: (s.selections || []).length, total: Math.round(tot * 100) / 100,
                     calc: (s.bets || []).map(x => ({ type: x.type, odds: x.totalOdds })) };
          } catch (e) { return { error: String(e).slice(0, 120) }; }
        }""")
        out["filled"] = state.get("n", 0)
        out["total_odds"] = state.get("total")
        # tenta o botão Partilhar (se existir sem login)
        try:
            btn = pg.evaluate("""() => {
              const els = Array.from(document.querySelectorAll('button, a'));
              const t = els.find(e => { const tx = (e.textContent || '').trim();
                return tx.length < 40 && /compartilhar/i.test(tx); });
              if (t) { t.click(); return true; } return false;
            }""")
            if btn:
                pg.wait_for_timeout(5000)
                try:
                    clip = pg.evaluate("() => navigator.clipboard.readText()")
                    if clip and clip.startswith("http"):
                        out["share_url"] = clip[:500]
                except Exception:
                    pass
        except Exception:
            pass
        if shot_path:
            try:
                pg.screenshot(path=shot_path)
            except Exception:
                pass
        b.close()
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Monta ficha no premierbet.co.ao (sem apostar)")
    ap.add_argument("--slip", required=True, help="BetSlip JSON nosso")
    ap.add_argument("--stake", type=int, default=1000, help="cêntimos de Kz (1000=Kz 10)")
    ap.add_argument("--headful", action="store_true", help="mostra o browser")
    ap.add_argument("--no-browser", action="store_true", help="só resolve (API)")
    ap.add_argument("--out", default="", help="grava resultado JSON")
    ap.add_argument("--shot", default="", help="screenshot de prova")
    args = ap.parse_args(argv)

    slip = json.loads(Path(args.slip).read_text(encoding="utf-8"))
    built = build_selections(slip)
    print(f"[book] {built['n_legs']} perna(s) resolvida(s), odd total {built['total_odds']}")
    for r in built["report"]:
        flag = "ok" if r["status"] == "ok" else "FALHA"
        print(f"  [{flag}] {r.get('home')} v {r.get('away')} "
              f"({r.get('market')}) -> {r.get('pb_market', '-')}/"
              f"{r.get('pb_outcome', '-')} @{r.get('pb_odd', '-')} :: {r['status']}")

    result = {"resolved": built}
    if not args.no_browser and built["selections"]:
        filled = fill_site(built["selections"], stake=args.stake,
                           headful=args.headful,
                           shot_path=args.shot or None)
        print(f"[book] ficha no site: {filled['filled']} seleções, odd {filled['total_odds']}")
        if filled.get("share_url"):
            print(f"[book] link partilhado: {filled['share_url']}")
        result["site"] = filled

    if args.out:
        Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=2),
                                  encoding="utf-8")
        print(f"[book] resultado em {args.out}")
    return 0 if built["selections"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
