"""Monta e coloca uma ficha no premierbet.co.ao a partir de um BetSlip nosso.

Fluxo:
  1. Para cada perna: localiza o jogo na API da Premier Bet
     (events/upcoming por data + fuzzy de nomes) e lê events/{id}
     (mercados, outcomes, odds atuais).
  2. Mapeia o nosso mercado (home/draw/away/double_chance_*/over*/under*/btts_*/dnb_*
     e tips compostas) para {marketId, outcomeId} da Premier Bet.
  3. Abre o site num browser Playwright, faz login (credenciais na env),
     injeta as seleções no localStorage (chave sah_ao-betslip — formato do site
     real), define o valor da aposta e, quando pedido, coloca a aposta.
  4. Devolve um JSON com o resultado, screenshot de prova e (se disponível) o
     ID da aposta.

Modos:
  - Resolver apenas (sem browser):
      python -X utf8 Scraping/premierbet_book.py --slip slip.json --no-browser
  - Preencher o boletim sem apostar (dry-run):
      python -X utf8 Scraping/premierbet_book.py --slip slip.json --stake 1000
  - Colocar a aposta:
      python -X utf8 Scraping/premierbet_book.py --slip slip.json --stake 1000 --place
  - Modo servidor (payload JSON, recomendado):
      python -X utf8 Scraping/premierbet_book.py --payload job.json --out result.json

Credenciais (env, nunca por argumentos):
  PREMIERBET_LOGIN      telefone/244..., nome de utilizador ou email
  PREMIERBET_PASSWORD   palavra-passe
  PREMIERBET_NO_SANDBOX=1  adiciona --no-sandbox (necessário em muitos contentores)

O valor (`stake`) é em Kwanzas (AOA), não em cêntimos: 1000 = Kz 1.000,00.
Nada é apostado sem `--place` / `"place": true`.
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys
import time
import traceback
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
UA = HEADERS["User-Agent"]

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


def _combo_total(base: str, direction: str, handicap: str):
    name = f"{base} + {direction}"
    return lambda o: o.get("name") == name and o.get("handicap") == handicap


def _combo_dc_total(base: str, direction: str, handicap: str):
    name = f"{base} / {direction}"
    return lambda o: o.get("name") == name and o.get("handicap") == handicap


def _combo_btts_total(btts: str, direction: str, handicap: str):
    name = f"{btts} + {direction}"
    return lambda o: o.get("name") == name and o.get("handicap") == handicap


def _combo_result_btts(base: str, btts: str):
    name = f"{base} + {btts}"
    return lambda o: o.get("name") == name


def _combo_dc_btts(base: str, btts: str):
    name = f"{base} / {btts}"
    return lambda o: o.get("name") == name


# Novos mercados COMPOSTOS: a Premier Bet já os expõe pré-combinados, pelo que
# não é preciso um bet builder próprio. Cada chave do nosso motor mapeia para
# um marketId/outcome real.
_TOTAL_LINES = {
    "over15": ("Acima", "1.5"),
    "over25": ("Acima", "2.5"),
    "over35": ("Acima", "3.5"),
    "over45": ("Acima", "4.5"),
    "under15": ("Abaixo", "1.5"),
    "under25": ("Abaixo", "2.5"),
    "under35": ("Abaixo", "3.5"),
    "under45": ("Abaixo", "4.5"),
}
for _key, _label in (("home", "1"), ("draw", "X"), ("away", "2")):
    for _line, (_direction, _handicap) in _TOTAL_LINES.items():
        MARKET_MAP[f"{_key}_{_line}"] = (
            "36",
            _combo_total(_label, _direction, _handicap),
        )
for _key, _label in (
    ("double_chance_1x", "1X"),
    ("double_chance_x2", "X2"),
    ("double_chance_12", "12"),
):
    for _line, (_direction, _handicap) in _TOTAL_LINES.items():
        MARKET_MAP[f"{_key}_{_line}"] = (
            "569",
            _combo_dc_total(_label, _direction, _handicap),
        )
for _key, _label in (("btts_yes", "Sim"), ("btts_no", "Não")):
    for _line, (_direction, _handicap) in _TOTAL_LINES.items():
        MARKET_MAP[f"{_key}_{_line}"] = (
            "414",
            _combo_btts_total(_label, _direction, _handicap),
        )
for _key, _label in (("home", "1"), ("draw", "X"), ("away", "2")):
    for _btts_key, _btts_label in (("btts_yes", "Sim Golos"), ("btts_no", "Não Golos")):
        MARKET_MAP[f"{_key}_{_btts_key}"] = (
            "386",
            _combo_result_btts(_label, _btts_label),
        )
for _key, _label in (
    ("double_chance_1x", "1X"),
    ("double_chance_x2", "X2"),
    ("double_chance_12", "12"),
):
    for _btts_key, _btts_label in (("btts_yes", "Sim"), ("btts_no", "Não")):
        MARKET_MAP[f"{_key}_{_btts_key}"] = (
            "570",
            _combo_dc_btts(_label, _btts_label),
        )


def _env_flag(name: str, default: bool = False) -> bool:
    v = (os.environ.get(name) or "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on", "sim")


def _norm(name: str) -> str:
    s = unicodedata.normalize("NFKD", (name or "").strip().lower())
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"^(fc|cf|sc|ac|cd|sd|ss|as|sk|rc|afc|real|club|deportivo)\s+", "", s)
    s = re.sub(r"\s+(fc|cf|sc|ac|cd|sd|ss|as|sk|rc|afc|cfc|club)$", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _sim(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, _norm(a), _norm(b)).ratio()


def _bet_type(n: int) -> str:
    """Tipo que o próprio site usa para uma múltipla com n seleções."""
    if n <= 1:
        return "SGL"
    if n == 2:
        return "DBL"
    if n == 3:
        return "TBL"
    return f"{n}FD" if n < 10 else f"{n}F"


class PBClient:
    def __init__(self):
        import curl_cffi.requests as cr
        self.s = cr.Session(impersonate="chrome131")
        self._upcoming_cache: dict[str, list] = {}

    def get(self, path: str, **params):
        r = self.s.get(BASE + path, headers=HEADERS,
                       params={**Q, **params}, timeout=25)
        r.raise_for_status()
        return r.json()

    def upcoming(self, date_ymd: str) -> list:
        """Todos os eventos de futebol de um dia (YYYY-MM-DD)."""
        if date_ymd in self._upcoming_cache:
            return self._upcoming_cache[date_ymd]
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
        self._upcoming_cache[date_ymd] = out
        return out

    def event(self, event_id: str) -> dict:
        return self.get(f"/events/{event_id}")


def find_event(client: PBClient, home: str, away: str, date_ymd: str,
               kickoff_ms: int | None = None,
               min_score: float = 0.68) -> dict | None:
    cands = []
    for ev in client.upcoming(date_ymd):
        s = (_sim(home, ev["home"]) + _sim(away, ev["away"])) / 2
        s_rev = (_sim(home, ev["away"]) + _sim(away, ev["home"])) / 2
        score = max(s, s_rev)
        if score < min_score:
            continue
        # O mesmo par de equipas pode alinhar em dias diferentes; o pontapé de
        # saída tem de coincidir (tolerância de 3h para fusos/arredondamentos).
        if kickoff_ms and ev.get("start"):
            try:
                if abs(int(ev["start"]) - int(kickoff_ms)) > 3 * 3600 * 1000:
                    continue
            except (TypeError, ValueError):
                pass
        cands.append((score, ev))
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
                if not o.get("active", True) or not want(o):
                    continue
                try:
                    odd = float(o.get("value"))
                except (TypeError, ValueError):
                    continue
                if odd <= 1.0:
                    continue
                return {"market": m, "outcome": o, "group": g.get("name")}
    return None


def to_selection(ev_detail: dict, market: dict, outcome: dict, stake: float = 0) -> dict:
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
        "isBetBuilderAvailable": bool(market.get("isBetBuilderAvailable", False)),
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
        ev = None
        home = leg.get("home") or ""
        away = leg.get("away") or ""
        base_date = ymd_of(leg)
        dates = [base_date]
        try:
            base_dt = datetime.strptime(base_date, "%Y-%m-%d")
            dates.append((base_dt - timedelta(days=1)).strftime("%Y-%m-%d"))
            dates.append((base_dt + timedelta(days=1)).strftime("%Y-%m-%d"))
        except ValueError:
            pass
        try:
            for date_ymd in dates:
                ev = find_event(client, home, away, date_ymd,
                                kickoff_ms=leg.get("kickoffAt"))
                if ev:
                    break
            if not ev:
                entry["status"] = "jogo não localizado"
                report.append(entry)
                continue
            if ev["id"] in seen_events:
                entry.update({"event_id": ev["id"], "status": "evento repetido — ignorado"})
                report.append(entry)
                continue
            detail = client.event(ev["id"])
        except Exception as exc:
            entry["status"] = f"erro na API: {exc}"
            report.append(entry)
            continue
        pick = pick_outcome(detail, market)
        if not pick:
            entry.update({"event_id": ev["id"],
                          "status": "mercado indisponível no evento"})
            report.append(entry)
            continue
        entry.update({
            "event_id": ev["id"],
            "event": f"{ev['home']} v {ev['away']}",
            "match_score": ev.get("match_score"),
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


# --------------------------------------------------------------------------
# Browser (login + boletim + aposta)
# --------------------------------------------------------------------------

_JS_SET_BETSLIP = """({selections, stake, type, multiple}) => {
  const slip = {
    selections: (selections || []).map(s => Object.assign({}, s, { bet: { stake: 0 } })),
    accaBetStake: stake,
    useBonus: false,
    bets: [{ type: type, multiple: multiple, stake: stake }],
    showMoreMultiples: false,
    location: 'default',
    lastSuccessful: 0
  };
  localStorage.setItem('sah_ao-betslip', JSON.stringify(slip));
  return slip;
}"""

_JS_READ_BETSLIP = """() => {
  try {
    const s = JSON.parse(localStorage.getItem('sah_ao-betslip') || 'null');
    if (!s) return { n: 0, total: null, acca: null, bets: [], button: '', stakeInput: '' };
    let tot = 1;
    for (const l of (s.selections || [])) tot *= parseFloat(l.outcomeValue) || 1;
    const btn = document.querySelector('.betslip-bet-button');
    const inp = document.querySelector('.betslip-stake input');
    return {
      n: (s.selections || []).length,
      total: Math.round(tot * 100) / 100,
      acca: s.accaBetStake,
      bets: (s.bets || []).map(x => ({
        type: x.type, multiple: x.multiple, stake: x.stake,
        possibleWinnings: x.possibleWinnings, totalOdds: x.totalOdds
      })),
      button: btn ? (btn.textContent || '').trim() : '',
      stakeInput: inp ? inp.value : ''
    };
  } catch (e) {
    return { n: 0, total: null, error: String(e).slice(0, 160), bets: [], button: '', stakeInput: '' };
  }
}"""

_JS_IS_LOGGED_IN = """() => {
  try {
    const raw = localStorage.getItem('sah_ao-user');
    if (raw && raw !== 'null' && raw !== 'undefined') {
      const u = JSON.parse(raw);
      if (u && typeof u === 'object') {
        if (u.account && (u.account.id || u.account.accountId || u.account.customerId)) return true;
        if (u.id || u.userId || u.user_id || u.token || u.email || u.username || u.login) return true;
      }
    }
  } catch (e) {}
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const texts = Array.from(document.querySelectorAll('button, a'))
    .filter(visible)
    .map(e => (e.textContent || '').trim());
  const loginVisible = texts.some(t => /iniciar\\s+sess/i.test(t));
  const accountVisible = texts.some(t =>
    /(depositar|levantar|sair|terminar\\s+sess|a\\s+minha\\s+conta|minha\\s+conta)/i.test(t));
  if (!loginVisible && accountVisible) return true;
  const btn = document.querySelector('.betslip-bet-button');
  const t = btn ? (btn.textContent || '').trim() : '';
  return Boolean(t) && !/iniciar\\s+sess/i.test(t);
}"""

_JS_LOGIN_ERROR = """() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const modals = Array.from(document.querySelectorAll('.modal, [role=dialog]'))
    .filter(e => /iniciar\\s+sess/i.test(e.textContent || ''));
  const scope = modals.length ? modals[0] : document.body;
  const errEls = Array.from(document.querySelectorAll(
    '.form-error, .form-input__error, .notification, [class*="error"], [class*="alert"], [role=alert]'
  )).filter(visible);
  const t = errEls.map(e => (e.textContent || '').trim()).filter(Boolean).join(' | ')
    || (scope.innerText || '');
  const m = t.match(/(credenciais[^.]{0,60}(inv[aá]lid|incorret|errad|n[aã]o\\s+(est[aã]o\\s+)?corret)[^.]{0,60}|dados\\s+de\\s+(in[ií]cio\\s+de\\s+sess[aã]o|login|acesso)\\s+inv[aá]lidos[^.]{0,100}|dados\\s+(inv[aá]lidos|incorretos)[^.]{0,100}|palavra[- ]passe[^.]{0,40}(incorret|inv[aá]lid)[^.]{0,60}|login[^.]{0,40}(incorret|inv[aá]lid)[^.]{0,60}|in[ií]cio\\s+de\\s+sess[aã]o[^.]{0,80}bloquead[oa][^.]{0,100}|conta[^.]{0,80}(bloqueada|suspensa)|demasiadas\\s+tentativas[^.]{0,100}|INVALID_LOGIN_DETAILS|AUTH_LIMIT_FAILED|LOGIN_IS_BLOCKED|INVALID_CREDENTIALS)/i);
  return m ? m[0].slice(0, 240) : null;
}"""

_JS_NEEDS_VERIFICATION = """() => {
  const modals = Array.from(document.querySelectorAll('.modal, [role=dialog]'))
    .filter(e => /iniciar\\s+sess|verifica/i.test(e.textContent || ''));
  const scope = modals.length ? modals[0] : document.body;
  const t = (scope.innerText || '');
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const codeInput = Array.from(document.querySelectorAll('input')).some(i =>
    visible(i) && /(code|otp|pin|token)/i.test(
      (i.name || '') + ' ' + (i.id || '') + ' ' + (i.placeholder || '')
    )
  );
  if (codeInput) return true;
  return /(c[oó]digo\\s+de\\s+verifica|verifica[cç][aã]o\\s+em\\s+dois\\s+passos|c[oó]digo\\s+SMS|\\botp\\b|introduz[^.]{0,40}\\bpin\\b|INVALID_PIN)/i.test(t);
}"""

_JS_LOGIN_CHALLENGE = """() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const frames = Array.from(document.querySelectorAll('iframe')).filter(visible);
  if (frames.some(f => /(turnstile|recaptcha|captcha|challenges\\.cloudflare\\.com)/i.test(f.src || ''))) {
    return 'captcha';
  }
  const captcha = document.querySelector('.cf-turnstile, [class*="captcha"]');
  if (captcha && visible(captcha)) return 'captcha';
  return '';
}"""

_JS_DISMISS_CONSENT = """() => {
  const sels = ['#onetrust-accept-btn-handler', '.cookie-consent button',
                '[class*="cookie"] button', '[id*="cookie"] button'];
  for (const s of sels) {
    const el = document.querySelector(s);
    if (el && /aceit|concord|permitir/i.test(el.textContent || '')) { el.click(); return true; }
  }
  const btns = Array.from(document.querySelectorAll('button')).filter(e =>
    /^(aceitar|aceitar todos|concordo|permitir todos)$/i.test((e.textContent || '').trim()));
  if (btns.length) { btns[0].click(); return true; }
  return false;
}"""


_JS_BET_BUTTON_STATE = """() => {
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const els = Array.from(document.querySelectorAll('.betslip-bet-button')).filter(visible);
  const isDisabled = (e) => Boolean(e.disabled) ||
    (e.getAttribute && e.getAttribute('aria-disabled') === 'true') ||
    /(^|\\s)(disabled|is-disabled)(\\s|$)/i.test(String(e.className || ''));
  const enabledIdx = els.findIndex((e) => !isDisabled(e));
  const idx = enabledIdx >= 0 ? enabledIdx : 0;
  const el = els.length ? els[idx] : null;
  const msgs = Array.from(document.querySelectorAll(
    '[class*="betslip"] [class*="error"], [class*="betslip"] [class*="warning"],' +
    '[class*="betslip"] [class*="alert"], [class*="betslip"] [class*="message"],' +
    '[role=alert], .notification, .modal'
  )).filter(visible)
    .map(e => (e.innerText || '').replace(/\\s+/g, ' ').trim())
    .filter(Boolean)
    .filter(t => !/^iniciar\\s+sess/i.test(t));
  let slip = null;
  try { slip = JSON.parse(localStorage.getItem('sah_ao-betslip') || 'null'); } catch (e) {}
  const bets = slip && Array.isArray(slip.bets) ? slip.bets : [];
  return {
    found: Boolean(el),
    index: els.length ? idx : -1,
    count: els.length,
    text: el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : '',
    disabled: el ? isDisabled(el) : true,
    pointerEvents: el ? getComputedStyle(el).pointerEvents : 'none',
    opacity: el ? Number(getComputedStyle(el).opacity || 0) : 0,
    nSelections: slip && Array.isArray(slip.selections) ? slip.selections.length : 0,
    winnings: bets.map(b => (b && b.possibleWinnings != null ? b.possibleWinnings : null)),
    msgs: msgs.slice(0, 8),
  };
}"""

_JS_ACCEPT_ODDS_SWITCH = """() => {
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const re = /aceitar\\s+altera[cç][oõ]es\\s+(das\\s+)?odds/i;
  const labels = Array.from(document.querySelectorAll('label, button, span, div'))
    .filter(e => visible(e) && re.test((e.innerText || '').trim()));
  if (!labels.length) return false;
  const scope = labels[0];
  const wrap = scope.closest('label, .switch, [class*="toggle"], [class*="switch"]') || scope.parentElement;
  const input = wrap ? wrap.querySelector('input[type=checkbox], input[type=radio]') : null;
  if (input) {
    if (input.checked) return false;
    input.click();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  scope.click();
  return true;
}"""


def _stake_fmt(stake: float) -> str:
    return f"{stake:.2f}"


def _bet_button_state(page) -> dict:
    try:
        return page.evaluate(_JS_BET_BUTTON_STATE) or {}
    except Exception:
        return {}


def _ensure_bet_button_ready(page, timeout_s: int = 25) -> dict:
    """Espera o botão de apostar ficar clicável.

    A Premier Bet desativa o botão enquanto recalcula odds ou enquanto existe
    uma alteração de odds por aceitar. Aceitamos essa alteração (modal/toggle)
    e esperamos; nunca clicamos em apostar mais de uma vez.
    """
    deadline = time.time() + timeout_s
    accepted_modal = False
    last = _bet_button_state(page)
    while time.time() < deadline:
        if not accepted_modal and re.search(
            r"aceitar\s+altera", " ".join(last.get("msgs") or []), re.I
        ):
            if _click_modal_button(page, r"aceitar\s+altera[cç]", [r"^aceitar|aceitar\s+altera"]):
                accepted_modal = True
                page.wait_for_timeout(1200)
                last = _bet_button_state(page)
                continue
        try:
            if page.evaluate(_JS_ACCEPT_ODDS_SWITCH):
                page.wait_for_timeout(1200)
                last = _bet_button_state(page)
                continue
        except Exception:
            pass

        last = _bet_button_state(page)
        if (
            last.get("found")
            and not last.get("disabled")
            and last.get("pointerEvents") != "none"
            and float(last.get("opacity") or 0) > 0.2
            and last.get("nSelections", 0) > 0
            and any(w is not None for w in (last.get("winnings") or []))
        ):
            return last
        page.wait_for_timeout(600)
    return last


def _bet_button_message(state: dict) -> str:
    msgs = [m for m in (state.get("msgs") or []) if m]
    detail = " | ".join(msgs[:3])[:400]
    base = (
        "O botão de apostar está desativado na Premier Bet."
        if state.get("found")
        else "Botão de apostar não encontrado no boletim da Premier Bet."
    )
    if detail:
        return f"{base} Motivo indicado pelo site: {detail}"
    return (
        f"{base} Verifique se as odds mudaram, se alguma seleção ficou "
        "indisponível (jogo a começar) e o saldo da conta."
    )



def _dismiss_consent(page) -> None:
    try:
        page.evaluate(_JS_DISMISS_CONSENT)
    except Exception:
        pass


def _is_logged_in(page) -> bool:
    try:
        return bool(page.evaluate(_JS_IS_LOGGED_IN))
    except Exception:
        return False


def _login(page, login: str, password: str) -> dict:
    """Faz login pelo modal do site. Devolve {ok, message}."""
    if _is_logged_in(page):
        return {"ok": True, "message": "Sessão já iniciada."}

    # Abrir o modal. Preferir o botão do header; fallback para evaluate.
    opened = False
    try:
        btn = page.get_by_role("button", name=re.compile(r"iniciar\s+sess[aã]o", re.I)).first
        btn.click(timeout=8000)
        opened = True
    except Exception:
        try:
            opened = bool(page.evaluate("""() => {
              const els = Array.from(document.querySelectorAll('button, a'));
              const el = els.find(e => /iniciar\\s+sess[aã]o/i.test((e.textContent || '').trim()));
              if (el) { el.click(); return true; }
              return false;
            }"""))
        except Exception:
            opened = False

    if not opened:
        return {"ok": False, "message": "Não foi possível abrir o formulário de login da Premier Bet."}

    try:
        page.wait_for_selector("input[name=login]:visible", state="visible", timeout=15000)
        page.locator("input[name=login]:visible").first.fill(login)
        page.locator("input[name=password]:visible").first.fill(password)
        page.locator("form.login-form button.form-button--primary:visible").first.click(timeout=8000)
    except Exception as exc:
        return {"ok": False, "message": f"Falha ao preencher o login: {exc}"}

    deadline = time.time() + 40
    while time.time() < deadline:
        if _is_logged_in(page):
            # Fechar o modal se ainda estiver aberto.
            try:
                if page.locator(".login-form").first.is_visible():
                    page.keyboard.press("Escape")
                    page.wait_for_timeout(400)
            except Exception:
                pass
            return {"ok": True, "message": "Login efetuado."}
        try:
            err = page.evaluate(_JS_LOGIN_ERROR)
        except Exception:
            err = None
        if err:
            safe_err = err
            if login and len(login) >= 4:
                safe_err = safe_err.replace(login, "[login]")
            return {"ok": False, "message": f"Login recusado pela Premier Bet: {safe_err}"}
        try:
            challenge = page.evaluate(_JS_LOGIN_CHALLENGE)
            if challenge == "captcha":
                return {
                    "ok": False,
                    "message": ("A Premier Bet pediu um captcha/verificação anti-bot. "
                                "Inicie sessão manualmente (PREMIERBET_HEADFUL=1) ou tente mais tarde."),
                }
        except Exception:
            pass
        try:
            if page.evaluate(_JS_NEEDS_VERIFICATION):
                return {
                    "ok": False,
                    "message": ("A Premier Bet pediu verificação adicional (código/PIN/OTP). "
                                "Inicie sessão manualmente ou desative a verificação em dois passos."),
                }
        except Exception:
            pass
        page.wait_for_timeout(600)

    return {
        "ok": False,
        "message": "Tempo esgotado à espera do login. Verifique as credenciais e tente novamente.",
    }


def _click_modal_button(page, modal_pattern: str, button_patterns: list[str]) -> bool:
    """Clica num botão DENTRO de um modal visível que corresponda ao padrão.

    Evita clicar em controlos soltos da página (ex.: o toggle "Aceitar
    Alterações das Odds" do boletim, que não é um botão de confirmação).
    """
    try:
        return bool(page.evaluate(
            """({modalPattern, buttonPatterns}) => {
              const reModal = new RegExp(modalPattern, 'i');
              const res = buttonPatterns.map(p => new RegExp(p, 'i'));
              const modals = Array.from(document.querySelectorAll(
                '.modal, [role=dialog], [class*="modal"]'
              )).filter(e => {
                const r = e.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && reModal.test(e.textContent || '');
              });
              for (const modal of modals) {
                const btns = Array.from(modal.querySelectorAll('button, a')).filter(e => {
                  const r = e.getBoundingClientRect();
                  const t = (e.textContent || '').trim();
                  return r.width > 0 && r.height > 0 && res.some(re => re.test(t));
                });
                if (btns.length) { btns[0].click(); return true; }
              }
              return false;
            }""",
            {"modalPattern": modal_pattern, "buttonPatterns": button_patterns},
        ))
    except Exception:
        return False


def _wait_place_outcome(page, timeout_s: int = 90) -> dict:
    """Espera pelo resultado da colocação. Nunca clica duas vezes em 'colocar'."""
    deadline = time.time() + timeout_s
    accepted_changes = False
    confirmed = False
    last_text = ""
    while time.time() < deadline:
        try:
            raw = page.evaluate("() => (document.body.innerText || '')")
        except Exception:
            raw = ""
        text = re.sub(r"\s+", " ", raw or "")
        last_text = text[-5000:]
        low = text.lower()

        if re.search(
            r"(aposta[s]?\s+(de\s+[^.]{0,60}\s+)?colocada[s]?\s+com\s+sucesso"
            r"|aposta\s+colocada\s+com\s+sucesso"
            r"|aposta\s+efetuada\s+com\s+sucesso"
            r"|apostas\s+de\s+[^.]{0,40}\s+colocadas\s+com\s+sucesso)",
            low,
        ):
            return {
                "ok": True,
                "placed": True,
                "unknown": False,
                "message": "Aposta colocada com sucesso na Premier Bet.",
                "detail": last_text,
            }

        if re.search(r"n[aã]o\s+conseguimos\s+confirmar", low):
            return {
                "ok": False,
                "placed": False,
                "unknown": True,
                "message": ("A Premier Bet não confirmou a colocação. Verifique as apostas "
                            "abertas na sua conta antes de tentar novamente."),
                "detail": last_text,
            }

        # Modal de alteração de odds: aceitar uma única vez, só dentro do modal.
        # (Antes do teste de falha: o aviso "odds alteradas" não é uma rejeição.)
        if not accepted_changes and re.search(r"aceitar\s+altera[cç]", low):
            if _click_modal_button(page, r"aceitar\s+altera[cç]", [r"^aceitar|aceitar\s+altera"]):
                accepted_changes = True
                page.wait_for_timeout(1200)
                continue

        if re.search(
            r"(aposta\s+rejeitada|coloca[cç][aã]o\s+da\s+aposta\s+foi\s+rejeitada"
            r"|saldo\s+insuficiente|n[aã]o\s+tens\s+saldo)",
            low,
        ):
            return {
                "ok": False,
                "placed": False,
                "unknown": False,
                "message": "A Premier Bet recusou a aposta (ver detalhe).",
                "detail": last_text,
            }

        # Modal de confirmação final: confirmar uma única vez, só dentro do modal.
        if not confirmed and re.search(r"confirmar\s+(a\s+)?aposta", low):
            if _click_modal_button(
                page, r"confirmar\s+(a\s+)?aposta",
                [r"^confirmar", r"colocar\s+aposta", r"^continuar"],
            ):
                confirmed = True
                page.wait_for_timeout(1200)
                continue

        # Aviso de "a processar" — continua à espera.
        page.wait_for_timeout(700)

    # Sem confirmação explícita: NUNCA assumir sucesso (evita duplicar apostas).
    return {
        "ok": False,
        "placed": False,
        "unknown": True,
        "message": ("Tempo esgotado à espera da confirmação da Premier Bet. "
                    "Verifique as apostas abertas na sua conta antes de tentar novamente."),
        "detail": last_text,
    }


def _parse_bet_id(page, text: str) -> str | None:
    try:
        dom_id = page.evaluate("""() => {
          const el = document.querySelector(
            '[class*="bet-id"], [class*="betId"], [class*="receipt"] [class*="id"]'
          );
          return el ? (el.textContent || '').trim().slice(0, 80) : null;
        }""")
        if dom_id and re.fullmatch(r"[A-Za-z0-9._-]{4,80}", dom_id):
            return dom_id
    except Exception:
        pass
    m = re.search(
        r"(?:id|n[uú]mero|refer[eê]ncia)\s*(?:da|de)?\s*(?:aposta)?\s*[:#]?\s*([A-Z0-9][A-Z0-9._-]{5,})",
        text or "",
        re.I,
    )
    return m.group(1) if m else None


def fill_and_place(selections: list, stake: float, place: bool, headful: bool,
                   shot_path: str | None, login: str, password: str) -> dict:
    """Abre o site, faz login, preenche o boletim e (se place) coloca a aposta."""
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

    stake = round(float(stake), 2)
    login = (login or "").strip()
    password = password or ""
    result: dict = {
        "ok": False,
        "placed": False,
        "dry_run": not place,
        "logged_in": False,
        "filled": 0,
        "total_odds": None,
        "stake": stake,
        "bet_id": None,
        "message": "",
        "detail": "",
        "screenshot": shot_path,
    }

    if stake <= 0:
        result["message"] = "Valor da aposta inválido."
        return result
    if place and not (login and password):
        result["message"] = (
            "Credenciais Premier Bet não configuradas (PREMIERBET_LOGIN / PREMIERBET_PASSWORD)."
        )
        return result

    login_warning = ""
    args = []
    if _env_flag("PREMIERBET_NO_SANDBOX"):
        args += ["--no-sandbox", "--disable-dev-shm-usage"]

    browser = None
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=not headful, args=args)
            context = browser.new_context(
                locale="pt-PT",
                timezone_id="Africa/Luanda",
                viewport={"width": 1366, "height": 900},
                user_agent=UA,
                extra_http_headers={"Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8"},
            )
            page = context.new_page()
            page.set_default_timeout(25000)
            page.goto(SITE + "/", wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(6000)
            _dismiss_consent(page)

            if login and password:
                login_res = _login(page, login, password)
                result["logged_in"] = bool(login_res.get("ok"))
                if not login_res.get("ok"):
                    login_warning = login_res.get("message", "Falha no login.")
                    result["message"] = login_warning
                    result["detail"] = login_warning
                    if place:
                        return result
            elif place:
                result["message"] = "Credenciais Premier Bet não configuradas."
                return result

            n = len(selections)
            page.evaluate(_JS_SET_BETSLIP, {
                "selections": selections,
                "stake": stake,
                "type": _bet_type(n),
                "multiple": n,
            })
            page.reload(wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(6000)

            try:
                page.wait_for_function(
                    """(n) => {
                      try {
                        const s = JSON.parse(localStorage.getItem('sah_ao-betslip') || 'null');
                        return s && Array.isArray(s.selections) && s.selections.length === n;
                      } catch (e) { return false; }
                    }""",
                    arg=n,
                    timeout=20000,
                )
            except PWTimeout:
                pass

            try:
                page.wait_for_function(
                    """() => {
                      try {
                        const s = JSON.parse(localStorage.getItem('sah_ao-betslip') || 'null');
                        return s && Array.isArray(s.bets) && s.bets.some(b => Number(b.possibleWinnings) > 0);
                      } catch (e) { return false; }
                    }""",
                    timeout=15000,
                )
            except PWTimeout:
                pass

            state = page.evaluate(_JS_READ_BETSLIP) or {}
            result["filled"] = int(state.get("n") or 0)
            result["total_odds"] = state.get("total")
            result["stake"] = float(state.get("acca") or stake)
            result["button_text"] = state.get("button")

            if result["filled"] != n:
                result["message"] = (
                    f"O boletim da Premier Bet ficou com {result['filled']} de {n} seleções."
                )
                result["detail"] = json.dumps(state, ensure_ascii=False)[:2000]
                _screenshot(page, shot_path)
                return result

            # Garantir que o valor aparece no campo do boletim.
            try:
                inp = page.locator(".betslip-stake input:visible").first
                inp.wait_for(state="visible", timeout=10000)
                current = (inp.input_value() or "").replace(",", ".").strip()
                try:
                    needs = abs(float(current) - stake) > 0.005
                except ValueError:
                    needs = True
                if needs:
                    inp.click()
                    inp.fill(_stake_fmt(stake))
                    inp.press("Tab")
                    page.wait_for_timeout(1500)
            except Exception:
                pass

            # Reconfirmar estado após eventual cálculo do site.
            state2 = page.evaluate(_JS_READ_BETSLIP) or {}
            result["filled"] = int(state2.get("n") or result["filled"])
            result["total_odds"] = state2.get("total") or result["total_odds"]
            result["stake"] = float(state2.get("acca") or result["stake"])
            result["button_text"] = state2.get("button") or result.get("button_text")

            if result["filled"] != n:
                result["message"] = (
                    f"O boletim ficou com {result['filled']} de {n} seleções após definir o valor; "
                    "a aposta NÃO foi colocada."
                )
                result["detail"] = json.dumps(state2, ensure_ascii=False)[:2000]
                _screenshot(page, shot_path)
                return result

            if not place:
                _screenshot(page, shot_path)
                dry_message = (
                    f"Boletim preenchido com {result['filled']} seleção(ões) e "
                    f"{_stake_fmt(result['stake'])} AOA. Modo de teste: aposta NÃO colocada."
                )
                if login and login_warning:
                    dry_message += f" Login NÃO efetuado: {login_warning}"
                result.update({
                    "ok": True,
                    "placed": False,
                    "dry_run": True,
                    "message": dry_message,
                    "detail": json.dumps(state2, ensure_ascii=False)[:2000],
                })
                return result

            # Estado do botão: o site desativa-o enquanto recalcula as odds ou
            # enquanto há alterações de odds por aceitar. Aceitamos/esperamos e,
            # se continuar bloqueado, recarregamos o boletim UMA vez (nova
            # cotação) antes de desistir.
            state = _ensure_bet_button_ready(page, 25)
            if "iniciar sess" in (state.get("text") or "").lower():
                result["message"] = "Sessão não iniciada na Premier Bet; a aposta não foi colocada."
                _screenshot(page, shot_path)
                return result
            if not (state.get("found") and not state.get("disabled")):
                page.reload(wait_until="domcontentloaded", timeout=60000)
                page.wait_for_timeout(6000)
                try:
                    inp2 = page.locator(".betslip-stake input:visible").first
                    inp2.fill(_stake_fmt(stake))
                    inp2.press("Tab")
                    page.wait_for_timeout(2000)
                except Exception:
                    pass
                state = _ensure_bet_button_ready(page, 20)

            result["button_text"] = state.get("text") or result.get("button_text")
            if (
                not state.get("found")
                or state.get("disabled")
                or state.get("pointerEvents") == "none"
                or float(state.get("opacity") or 0) <= 0.2
            ):
                result["message"] = _bet_button_message(state)
                result["detail"] = json.dumps(state, ensure_ascii=False)[:2000]
                _screenshot(page, shot_path)
                return result

            if int(state.get("nSelections") or 0) < n:
                result["message"] = (
                    f"O boletim ficou com {state.get('nSelections')} de {n} seleções "
                    "antes de apostar; a aposta NÃO foi colocada."
                )
                result["detail"] = json.dumps(state, ensure_ascii=False)[:2000]
                _screenshot(page, shot_path)
                return result

            # Clicar UMA única vez no botão que está ATIVO (pode haver mais do
            # que um .betslip-bet-button na página: sticky footer/modal).
            try:
                btn = page.locator(".betslip-bet-button:visible").nth(
                    max(0, int(state.get("index") or 0))
                )
                btn.wait_for(state="visible", timeout=20000)
            except Exception as exc:
                result["message"] = f"Botão de apostar não visível na Premier Bet: {exc}"
                _screenshot(page, shot_path)
                return result

            try:
                btn.click(timeout=15000)
            except Exception:
                try:
                    btn.evaluate("e => e.click()")
                except Exception as exc:
                    result["message"] = f"Não foi possível clicar em colocar aposta: {exc}"
                    _screenshot(page, shot_path)
                    return result

            outcome = _wait_place_outcome(page)
            result.update(outcome)
            if outcome.get("ok"):
                bet_id = _parse_bet_id(page, outcome.get("detail") or "")
                if bet_id:
                    result["bet_id"] = bet_id
                result["message"] = "Aposta colocada com sucesso na Premier Bet."
            elif outcome.get("unknown"):
                result["message"] = outcome.get("message", result["message"])
            else:
                result["message"] = outcome.get("message", "A aposta não foi colocada.")

            _screenshot(page, shot_path)
            return result
    except Exception as exc:
        result["message"] = f"Erro no browser da Premier Bet: {exc}"
        result["detail"] = traceback.format_exc()[-3000:]
        return result
    finally:
        try:
            if browser is not None:
                browser.close()
        except Exception:
            pass


def _screenshot(page, path: str | None) -> None:
    if not path:
        return
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=path, full_page=False)
    except Exception:
        pass


def _write_result(path: str | None, result: dict) -> None:
    if not path:
        return
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps(result, ensure_ascii=False, indent=2),
                              encoding="utf-8")
    except Exception as exc:
        print(f"[book] falha ao gravar resultado: {exc}", file=sys.stderr)


def _log_resolution(built: dict) -> None:
    print(f"[book] {built['n_legs']} perna(s) resolvida(s), odd total {built['total_odds']}")
    for r in built["report"]:
        flag = "ok" if r["status"] == "ok" else "FALHA"
        print(f"  [{flag}] {r.get('home')} v {r.get('away')} "
              f"({r.get('market')}) -> {r.get('pb_market', '-')}/"
              f"{r.get('pb_outcome', '-')} @{r.get('pb_odd', '-')} :: {r['status']}")


def _partial_note(built: dict, expected: int) -> str:
    """Texto quando só parte das pernas foi localizada (ficha sobe com as boas)."""
    missing = [r for r in (built.get("report") or []) if r.get("status") != "ok"]
    detail = "; ".join(
        f"{r.get('home')} v {r.get('away')}: {r.get('status')}"
        for r in missing[:4]
    )
    if len(missing) > 4:
        detail += "; …"
    return (
        f"Enviadas {built.get('n_legs', 0)} de {expected} pernas — os jogos não "
        "localizados na Premier Bet foram retirados da ficha."
        + (f" {detail}" if detail else "")
    )


def _placed_legs(built: dict) -> list[dict]:
    """Pernas efetivamente enviadas (status ok), para o servidor sincronizar."""
    return [
        {"home": r.get("home"), "away": r.get("away"), "market": r.get("market")}
        for r in (built.get("report") or [])
        if r.get("status") == "ok"
    ]


def _partial_result_message(built: dict, expected: int) -> str:
    missing = [r for r in (built.get("report") or []) if r.get("status") != "ok"]
    detail = "; ".join(
        f"{r.get('home')} v {r.get('away')}: {r.get('status')}"
        for r in missing[:4]
    )
    if len(missing) > 4:
        detail += "; …"
    return (
        f"Apenas {built.get('n_legs', 0)} de {expected} pernas foram localizadas "
        f"na Premier Bet. A aposta NÃO foi colocada."
        + (f" {detail}" if detail else "")
    )


def _payload_bool(value, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on", "sim")
    return default


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Monta/coloca uma ficha no premierbet.co.ao (credenciais na env)")
    ap.add_argument("--slip", default="", help="BetSlip JSON nosso")
    ap.add_argument("--payload", default="", help="Job JSON do servidor (slip+stake+place)")
    ap.add_argument("--stake", type=float, default=1000.0,
                    help="valor em Kwanzas (1000 = Kz 1.000,00)")
    ap.add_argument("--place", action="store_true", help="colocar a aposta (dinheiro real)")
    ap.add_argument("--dry-run", action="store_true", help="só preencher, não apostar")
    ap.add_argument("--headful", action="store_true", help="mostra o browser")
    ap.add_argument("--no-browser", action="store_true", help="só resolve (API)")
    ap.add_argument("--strict", action="store_true",
                    help="aborta se alguma perna não for localizada (default: sobe com as disponíveis)")
    ap.add_argument("--out", default="", help="grava resultado JSON")
    ap.add_argument("--shot", default="", help="screenshot de prova")
    args = ap.parse_args(argv)

    login = (os.environ.get("PREMIERBET_LOGIN") or os.environ.get("PREMIERBET_USERNAME") or "").strip()
    password = os.environ.get("PREMIERBET_PASSWORD") or ""

    if args.payload:
        try:
            payload = json.loads(Path(args.payload).read_text(encoding="utf-8-sig"))
        except Exception as exc:
            result = {"ok": False, "placed": False, "message": f"Payload inválido: {exc}"}
            _write_result(args.out, result)
            print(f"[book] {result['message']}", file=sys.stderr)
            return 2

        slip = payload.get("slip") or {}
        raw_stake = payload.get("stake", args.stake)
        try:
            stake = (
                float(raw_stake)
                if raw_stake is not None and str(raw_stake).strip() != ""
                else 0.0
            )
        except (TypeError, ValueError):
            stake = 0.0
        place = _payload_bool(payload.get("place", args.place))
        dry_run = _payload_bool(payload.get("dry_run", not place))
        if dry_run:
            place = False
        headful = _payload_bool(payload.get("headful", args.headful))
        # Por omissão, uma perna não localizada NÃO impede a aposta: sobe-se
        # com as pernas disponíveis. PREMIERBET_REQUIRE_ALL=1 repõe o modo
        # estrito (aborta se faltar alguma).
        strict = _payload_bool(
            payload.get("require_all", os.environ.get("PREMIERBET_REQUIRE_ALL", ""))
        )
        shot = payload.get("shot") or args.shot or None

        result = {
            "ok": False,
            "placed": False,
            "dry_run": not place,
            "stake": stake,
            "message": "",
            "resolved": None,
        }
        try:
            built = build_selections(slip)
            result["resolved"] = built
            _log_resolution(built)
            expected = len(slip.get("legs") or [])
            partial = 0 < built["n_legs"] < expected
            if not built["selections"] or (partial and strict):
                result["message"] = _partial_result_message(built, expected)
                result["detail"] = json.dumps(
                    built.get("report") or [], ensure_ascii=False
                )[:4000]
                print(f"[book] {result['message']}")
                _write_result(args.out, result)
                return 1
            if partial:
                result["partial"] = True
                result["expected_legs"] = expected
                result["placed_legs"] = _placed_legs(built)
                print(f"[book] {_partial_note(built, expected)}")
            site = fill_and_place(
                built["selections"], stake=stake, place=place, headful=headful,
                shot_path=shot, login=login, password=password,
            )
            result.update(site)
            result["resolved"] = built
            result["ok"] = bool(site.get("ok"))
            result["placed"] = bool(site.get("placed"))
            result["dry_run"] = bool(site.get("dry_run", not place))
            if partial and site.get("ok"):
                result["message"] = (
                    f"{_partial_note(built, expected)} {site.get('message') or ''}"
                ).strip()
            print(f"[book] {result['message']}")
            _write_result(args.out, result)
            return 0 if result["ok"] else 1
        except Exception as exc:
            result["message"] = f"Erro inesperado: {exc}"
            result["detail"] = traceback.format_exc()[-3000:]
            print(f"[book] {result['message']}", file=sys.stderr)
            _write_result(args.out, result)
            return 2

    if not args.slip:
        ap.error("indique --slip ou --payload")

    slip = json.loads(Path(args.slip).read_text(encoding="utf-8-sig"))
    built = build_selections(slip)
    _log_resolution(built)

    result: dict = {"ok": bool(built["selections"]), "resolved": built}
    expected = len(slip.get("legs") or [])
    partial = 0 < built["n_legs"] < expected
    if not args.no_browser and built["selections"]:
        if partial and args.strict:
            result["ok"] = False
            result["message"] = _partial_result_message(built, expected)
            result["detail"] = built.get("report") or []
            print(f"[book] {result['message']}")
            _write_result(args.out, result)
            return 1
        if partial:
            result["partial"] = True
            result["expected_legs"] = expected
            result["placed_legs"] = _placed_legs(built)
            print(f"[book] {_partial_note(built, expected)}")
        place = bool(args.place) and not bool(args.dry_run)
        filled = fill_and_place(
            built["selections"], stake=args.stake, place=place,
            headful=args.headful, shot_path=args.shot or None,
            login=login, password=password,
        )
        result.update(filled)
        result["ok"] = bool(filled.get("ok"))
        result["placed"] = bool(filled.get("placed"))
        if partial and filled.get("ok"):
            result["message"] = (
                f"{_partial_note(built, expected)} {filled.get('message') or ''}"
            ).strip()
        print(f"[book] {filled.get('message')}")
    elif not built["selections"]:
        result["message"] = "Nenhuma perna da ficha foi localizada na Premier Bet."

    _write_result(args.out, result)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
