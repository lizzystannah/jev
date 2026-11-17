/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * AISCORE — Node bridge (JSON) + MatchContext mapping.
 *
 * Node fetch cannot pass Cloudflare. All live calls go through
 * Scraping/aiscore_bridge.py with the workspace venv (curl_cffi chrome131).
 * Throttle >= 1.6s is enforced in Python; here we also serialize spawns
 * so concurrent enrichments do not stack processes.
 *
 * Score rule (validado): homeScores/awayScores packed sint32 zigzag
 * [FT, 1H, 2H, ...]; FT = scores[0]; nunca somar períodos.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { MatchContext, MatchItem, TeamForm, TeamH2H } from './types.js';
import { writeJsonAtomic, writeJsonAtomicSync } from './atomicFile.js';
import { resolvePythonBin, runPythonJson } from './pythonBridge.js';
import { aiscoreDayKey, aiscoreDatesCovering } from './time.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, '..');

const BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'Scraping', 'aiscore_bridge.py');

const PYTHON_BIN = resolvePythonBin(['AISCORE_PYTHON'], [WORKSPACE_ROOT, PROJECT_ROOT]);

function envInt(name: string, fb: number, min = 0): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= min ? Math.trunc(n) : fb;
}

function envBool(name: string, fb: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw ? ['1', 'true', 'yes', 'on'].includes(raw) : fb;
}

const CACHE_FILE = path.join(PROJECT_ROOT, '.aiscore_context_cache.json');
const CACHE_TTL_MS = Math.max(60_000, envInt('AISCORE_CACHE_TTL_MINUTES', 360) * 60_000);
/** Gravação do cache em disco é agrupada: no máximo 1x por este intervalo. */
const CACHE_SAVE_DEBOUNCE_MS = Math.max(1_000, envInt('AISCORE_CACHE_SAVE_DEBOUNCE_MS', 15_000));
const BRIDGE_TIMEOUT_MS = Math.max(10_000, envInt('AISCORE_BRIDGE_TIMEOUT_MS', 120_000));
const SPAWN_GAP_MS = Math.max(0, envInt('AISCORE_SPAWN_GAP_MS', 1700)); // >= 1.6s between bridge processes

/** Enriquecimento síncrono (cabe na geração de fichas). */
const ENRICH_MAX_MATCHES = Math.max(0, envInt('AISCORE_ENRICH_MAX_MATCHES', 6));
const ENRICH_DEADLINE_MS = Math.max(1_000, envInt('AISCORE_ENRICH_DEADLINE_MS', 18_000));
/** Enriquecimento em background (não bloqueia a geração). */
const ENRICH_BACKGROUND_ENABLED = envBool('AISCORE_BACKGROUND_ENRICH', true);
const ENRICH_BACKGROUND_MAX = Math.max(0, envInt('AISCORE_ENRICH_BACKGROUND_MAX', 40));
const ENRICH_BACKGROUND_DEADLINE_MS = Math.max(
  1_000,
  envInt('AISCORE_ENRICH_BACKGROUND_DEADLINE_MS', 90_000)
);

// ---------------------------------------------------------------- zigzag ---

export function decodePackedSint32(buffer: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < buffer.length) {
    let shift = 0;
    let v = 0;
    // [AS-7] `shift` sem limite e um varint truncado empurravam um valor
    // parcial para o resultado (placar errado).
    let truncated = false;
    while (true) {
      if (i >= buffer.length) {
        truncated = true;
        break;
      }
      const x = buffer[i++];
      v |= (x & 0x7f) << shift;
      if (!(x & 0x80)) break;
      shift += 7;
      if (shift > 28) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
    out.push((v >>> 1) ^ -(v & 1));
  }
  return out;
}

/** [FT, 1H, 2H, ET1, ET2, Pens, ...] — FT = index 0; nunca somar 1H+2H. */
export function parseMatchScores(homeBuffer?: Uint8Array, awayBuffer?: Uint8Array): {
  ftHome: number | null;
  ftAway: number | null;
  htHome: number | null;
  htAway: number | null;
  penaltiesHome: number | null;
  penaltiesAway: number | null;
} {
  const home = homeBuffer ? decodePackedSint32(homeBuffer) : [];
  const away = awayBuffer ? decodePackedSint32(awayBuffer) : [];
  if (home.length === 0 || away.length === 0) {
    return {
      ftHome: null,
      ftAway: null,
      htHome: null,
      htAway: null,
      penaltiesHome: null,
      penaltiesAway: null,
    };
  }
  return {
    ftHome: home[0] ?? null,
    ftAway: away[0] ?? null,
    htHome: home[1] ?? null,
    htAway: away[1] ?? null,
    penaltiesHome: home[5] ?? null,
    penaltiesAway: away[5] ?? null,
  };
}

// ------------------------------------------------------------ bridge call ---

interface BridgeOk<T = unknown> {
  ok: true;
  type?: string;
  data?: T;
  count?: number;
  oddsCount?: number;
}
interface BridgeErr {
  ok: false;
  error: string;
  type?: string | null;
}
type BridgeResult<T = unknown> = BridgeOk<T> | BridgeErr;

let callChain: Promise<unknown> = Promise.resolve();
let lastSpawnAt = 0;

async function runBridge<T>(payload: Record<string, unknown>): Promise<BridgeResult<T>> {
  const exec = async (): Promise<BridgeResult<T>> => {
    const wait = lastSpawnAt + SPAWN_GAP_MS - Date.now();
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }

    if (!fs.existsSync(BRIDGE_SCRIPT)) {
      return { ok: false, error: `bridge not found: ${BRIDGE_SCRIPT}` };
    }
    const isBareCommand = !PYTHON_BIN.includes('/') && !PYTHON_BIN.includes('\\');
    if (!isBareCommand && !fs.existsSync(PYTHON_BIN)) {
      return { ok: false, error: `python not found: ${PYTHON_BIN} (set AISCORE_PYTHON)` };
    }

    try {
      // Payload por stdin (evita o limite de argv no Windows) e leitura do
      // JSON mesmo com exit code != 0.
      const data = await runPythonJson<BridgeResult<T>>(
        PYTHON_BIN,
        BRIDGE_SCRIPT,
        payload,
        {
          cwd: WORKSPACE_ROOT,
          timeoutMs: BRIDGE_TIMEOUT_MS,
          maxBytes: 8 * 1024 * 1024,
        }
      );
      return data;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'bridge execution failed' };
    } finally {
      // [AS-4] O espaçamento mede-se no FIM da chamada: medindo no início,
      // uma chamada lenta (day_card com 30 odds) colava a seguinte e o
      // intervalo de 1,6 s deixava de existir.
      lastSpawnAt = Date.now();
    }
  };

  const next = callChain.then(exec, exec);
  callChain = next.catch(() => undefined);
  return next;
}

function unwrap<T>(res: BridgeResult<T>): T {
  if (!res.ok) {
    throw new Error(`[AiScore] ${res.error}`);
  }
  return (res as BridgeOk<T>).data as T;
}

// ----------------------------------------------------------------- types ----

export interface ScoutTeamRef {
  id: string | null;
  name: string | null;
}

export interface ScoutFormRow {
  id?: string;
  date?: string | null;
  finished?: boolean;
  result?: 'W' | 'D' | 'L' | null;
  gf?: number | null;
  ga?: number | null;
  ft_home?: number | null;
  ft_away?: number | null;
  score?: string | null;
  home?: string;
  away?: string;
}

export interface ScoutForm {
  n?: number;
  W?: number;
  D?: number;
  L?: number;
  GF?: number;
  GA?: number;
  form?: string;
  matches?: ScoutFormRow[];
}

export interface ScoutH2HRow extends ScoutFormRow {
  home_id?: string | null;
  away_id?: string | null;
  focal_result?: 'W' | 'D' | 'L';
}

export interface ScoutPayload {
  match_id: string;
  kickoff?: string | null;
  home: ScoutTeamRef;
  away: ScoutTeamRef;
  competition?: string | null;
  home_form?: ScoutForm;
  away_form?: ScoutForm;
  h2h?: ScoutH2HRow[];
  h2h_summary?: { W?: number; D?: number; L?: number };
  home_trend?: Record<string, unknown> | null;
  away_trend?: Record<string, unknown> | null;
  competition_id?: string | null;
  /** Tendências da 2ª amostra + distribuidores — ver motor local. */
  home_trend_sc?: Record<string, unknown> | null;
  away_trend_sc?: Record<string, unknown> | null;
  market_hints?: Record<string, number | null>;
  /** Extras do bridge: { goal_distributions, home_stats, away_stats, h2h_stats }. */
  advanced?: any;
}

export interface AiscoreMatchMeta {
  match_id: string;
  kickoff?: string | null;
  home: ScoutTeamRef;
  away: ScoutTeamRef;
  competition?: string | null;
  competition_id?: string | null;
  statusId?: number | null;
  matchStatus?: number | null;
  /** Jogo terminado (statusId 8 / matchStatus 3), com placar no day card. */
  finished?: boolean;
  ft_home?: number | null;
  ft_away?: number | null;
  ht_home?: number | null;
  ht_away?: number | null;
}

export interface AiscoreDayCardMatch extends AiscoreMatchMeta {
  odds?: { home: number; draw: number; away: number } | null;
}

export interface AiscoreLiveResult {
  match_id: string;
  statusId?: number | null;
  matchStatus?: number | null;
  /** true quando statusId===8 ou matchStatus===3 (jogo terminado). */
  finished: boolean;
  ft_home?: number | null;
  ft_away?: number | null;
  ht_home?: number | null;
  ht_away?: number | null;
  kickoff?: string | null;
}

export interface AiscoreDayCardResult {
  type?: string;
  count?: number;
  oddsCount?: number;
  data?: AiscoreDayCardMatch[];
}

// ------------------------------------------------------------- cache layer ---

interface CacheEntry {
  at: number;
  aiscoreMatchId?: string;
  context?: MatchContext;
  scout?: ScoutPayload;
  tables?: any;
  lineups?: any;
}

type ContextCache = Record<string, CacheEntry>;

let memoryCache: ContextCache | null = null;
let cacheSaveTimer: NodeJS.Timeout | null = null;

/** [AS-3] Pedidos de scout em voo (chave → promessa). */
const inflightScout = new Map<string, Promise<ScoutPayload | null>>();
/** [AS-3] Cache negativa: chave → válido até (ms). */
const negativeScout = new Map<string, number>();
const NEGATIVE_TTL_MS = Math.max(60_000, envInt('AISCORE_NEGATIVE_TTL_MINUTES', 30) * 60_000);

function loadCache(): ContextCache {
  if (memoryCache) return memoryCache;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      memoryCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as ContextCache;
    } else {
      memoryCache = {};
    }
  } catch {
    memoryCache = {};
  }
  return memoryCache!;
}

/** Remove entradas expiradas para o cache não crescer indefinidamente. */
function pruneCache(cache: ContextCache): number {
  const now = Date.now();
  let removed = 0;
  for (const key of Object.keys(cache)) {
    const entry = cache[key];
    if (!entry || now - entry.at >= CACHE_TTL_MS) {
      delete cache[key];
      removed += 1;
    }
  }
  return removed;
}

function compactCache(cache: ContextCache): ContextCache {
  // [AS-6] O contexto é DERIVADO do scout: não se guarda duplicado (o
  // ficheiro pode ter dezenas de MB).
  const compact: ContextCache = {};
  for (const [key, entry] of Object.entries(cache)) {
    compact[key] = { ...entry, context: undefined };
  }
  return compact;
}

/** Escrita síncrona (só para o shutdown). */
export function flushCacheNow(): void {
  cacheSaveTimer = null;
  try {
    const cache = loadCache();
    const removed = pruneCache(cache);
    // Compacto (sem indentação) e atómico: um ficheiro truncado fazia o
    // cache ser ignorado em silêncio (e perdia-se todo o enriquecimento).
    writeJsonAtomicSync(CACHE_FILE, compactCache(cache));
    if (removed > 0) {
      console.log(
        `[AiScore] Cache podado: ${removed} entrada(s) expirada(s); ` +
          `${Object.keys(cache).length} mantida(s).`
      );
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * Escrita assíncrona (debounce normal): um ficheiro de dezenas de MB não
 * pode bloquear o event loop.
 */
async function flushCacheAsync(): Promise<void> {
  cacheSaveTimer = null;
  try {
    const cache = loadCache();
    const removed = pruneCache(cache);
    await writeJsonAtomic(CACHE_FILE, compactCache(cache));
    if (removed > 0) {
      console.log(
        `[AiScore] Cache podado: ${removed} entrada(s) expirada(s); ` +
          `${Object.keys(cache).length} mantida(s).`
      );
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * Marca o cache como alterado. A escrita física é agrupada (debounce) para
 * não reescrever o ficheiro inteiro a cada jogo enriquecido.
 */
function saveCache(): void {
  if (cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(() => {
    void flushCacheAsync().catch(() => undefined);
  }, CACHE_SAVE_DEBOUNCE_MS);
  cacheSaveTimer.unref?.();
}

process.once('exit', () => {
  if (cacheSaveTimer) {
    clearTimeout(cacheSaveTimer);
    flushCacheNow();
  }
});

// [AS-6] O 'exit' não corre em SIGINT/SIGTERM: garante-se a escrita.
let shuttingDown = false;
const onSignal = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  flushCacheNow();
};
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

function cacheKey(home: string, away: string, dateStr: string): string {
  return `${home.trim().toLowerCase()}||${away.trim().toLowerCase()}||${dateStr}`;
}

// [X-3] A data do AiScore (UTC−3) vem de `time.ts` — uma única fonte de
// verdade. `aiscoreDateKey`/`aiscoreYmd` viveram aqui com convenções
// diferentes (UTC−3 e UTC+1) e o mesmo jogo recebia duas datas.
export { aiscoreDayKey as aiscoreDateKey, aiscoreDatesCovering };

function fresh(entry?: CacheEntry): entry is CacheEntry {
  return Boolean(entry && Date.now() - entry.at < CACHE_TTL_MS);
}

/** season_id algures nas goal_distributions do advanced. */
function firstSeasonId(advanced: any): string | null {
  const gds = Array.isArray(advanced?.goal_distributions) ? advanced.goal_distributions : [];
  for (const gd of gds) {
    if (gd?.season_id) return gd.season_id;
  }
  return null;
}

// --------------------------------------------------------- context mapping ---

function parseKickoffMs(kickoff?: string | null, fallback?: number): number | undefined {
  if (!kickoff) return fallback;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(kickoff);
  if (!m) {
    const t = Date.parse(kickoff);
    return Number.isFinite(t) ? t : fallback;
  }
  const [, y, mo, d, h, mi] = m;
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:00-03:00`);
}

export { parseKickoffMs };

function lastFinishedRows(form?: ScoutForm, limit = 5): ScoutFormRow[] {
  const rows = (form?.matches || []).filter(
    (r) => r && r.finished && r.result && r.gf != null && r.ga != null
  );
  return rows.slice(0, limit);
}

function toTeamForm(form?: ScoutForm): TeamForm {
  const rows = lastFinishedRows(form, 5);
  const recentForm = rows
    .map((r) => r.result)
    .filter((r): r is 'W' | 'D' | 'L' => r === 'W' || r === 'D' || r === 'L')
    .reverse();

  const n = rows.length || 1;
  const scored = rows.reduce((s, r) => s + (r.gf || 0), 0);
  const conceded = rows.reduce((s, r) => s + (r.ga || 0), 0);
  const cleanSheets = rows.filter((r) => (r.ga || 0) === 0).length;

  return {
    recentForm,
    goalsScoredAvg5: Number((scored / n).toFixed(2)),
    goalsConcededAvg5: Number((conceded / n).toFixed(2)),
    cleanSheetPct: Math.round((cleanSheets / n) * 100),
    // [TY-4/AS-5] O motor precisa de saber se "0 gols médios" é real ou
    // apenas falta de amostra.
    sample: rows.length,
  };
}

function toTeamH2H(scout: ScoutPayload): TeamH2H {
  const summary = scout.h2h_summary || {};
  const finished = (scout.h2h || []).filter(
    (r) => r && r.finished && r.ft_home != null && r.ft_away != null
  );

  const totals = finished.map((r) => (r.ft_home || 0) + (r.ft_away || 0));
  const avgGoals = totals.length
    ? Number((totals.reduce((a, b) => a + b, 0) / totals.length).toFixed(2))
    : 0;
  const both = finished.filter((r) => (r.ft_home || 0) > 0 && (r.ft_away || 0) > 0).length;
  const bothScoredPct = finished.length ? Math.round((both / finished.length) * 100) : 0;

  // [AS-5] `winner` é relativo à EQUIPA FOCAL (a que estamos a avaliar), não
  // ao mandante do confronto antigo: quando as equipas trocaram de campo,
  // "home" como mandante de então dá a leitura errada.
  const focalId = scout.home?.id ?? null;
  const lastEncounters = finished.slice(0, 5).map((r) => {
    const fh = r.ft_home || 0;
    const fa = r.ft_away || 0;
    let winner: 'home' | 'away' | 'draw';
    if (fh === fa) {
      winner = 'draw';
    } else {
      const focalIsHome = focalId != null && r.home_id === focalId;
      const homeWon = fh > fa;
      winner = homeWon === focalIsHome ? 'home' : 'away';
    }
    return {
      date: (r.date || '').slice(0, 10),
      score: r.score || `${fh}-${fa}`,
      winner,
    };
  });

  return {
    homeWins: summary.W || 0,
    draws: summary.D || 0,
    awayWins: summary.L || 0,
    avgGoals,
    bothScoredPct,
    sample: finished.length,
    lastEncounters,
  };
}

function restDaysFrom(kickoffMs: number | undefined, form?: ScoutForm): number {
  if (!kickoffMs) return 3;
  const row = lastFinishedRows(form, 1)[0];
  const lastMs = row?.date ? parseKickoffMs(row.date) : undefined;
  if (!lastMs) return 3;
  const days = Math.floor((kickoffMs - lastMs) / (24 * 60 * 60 * 1000));
  return Math.max(0, Math.min(30, days));
}

function inferImportance(scout: ScoutPayload): MatchContext['importance'] {
  const comp = (scout.competition || '').toLowerCase();
  if (/derbi|derby/.test(comp)) return 'derby';
  if (/final|semifinal|play-?off|knockout|relegation|descenso/.test(comp)) return 'decisiva';
  if (
    /nations|champions|europa league|world cup|copa|mundial|primeira|premier|la liga|serie a|bundesliga|ligue 1/.test(
      comp
    )
  ) {
    return 'alta';
  }
  return 'normal';
}

/** Map validated scout payload -> MatchContext consumed by the local engine. */
export function scoutToMatchContext(scout: ScoutPayload, kickoffMs?: number): MatchContext {
  return {
    h2h: toTeamH2H(scout),
    homeForm: toTeamForm(scout.home_form),
    awayForm: toTeamForm(scout.away_form),
    importance: inferImportance(scout),
    restDaysHome: restDaysFrom(kickoffMs, scout.home_form),
    restDaysAway: restDaysFrom(kickoffMs, scout.away_form),
  };
}

// ----------------------------------------------------------- public API ------

export class AiscoreService {
  /** Um único enriquecimento em background de cada vez (evita fila infinita). */
  private backgroundEnrich: Promise<number> | null = null;

  public async status(): Promise<Record<string, unknown>> {
    const res = await runBridge({ action: 'status' });
    return {
      provider: 'AiScore API',
      baseUrl: 'https://api.aiscore.com/v1/web/api/',
      transport: 'python-bridge (curl_cffi chrome131)',
      throttle: '1.6s',
      pythonBin: PYTHON_BIN,
      bridgeScript: BRIDGE_SCRIPT,
      ...res,
    };
  }

  public async getMatchesForDate(
    dateStr: string,
    opts: { upcoming?: boolean; limit?: number } = {}
  ): Promise<AiscoreMatchMeta[]> {
    const date = dateStr.replace(/-/g, '');
    const res = await runBridge<AiscoreMatchMeta[]>({
      action: 'matches_date',
      date,
      upcoming: opts.upcoming ?? false,
      limit: opts.limit || 0,
    });
    if (!res.ok) throw new Error(`[AiScore] matches_date: ${res.error}`);
    return (res.data || []) as AiscoreMatchMeta[];
  }

  /**
   * Day card: matches for YYYYMMDD + optional European 1X2 odds (match/odd).
   * `oddsLimit` bounds N API calls (each +1.6s throttle inside the bridge).
   */
  public async getDayCard(
    dateStr: string,
    opts: {
      upcoming?: boolean;
      limit?: number;
      withOdds?: boolean;
      oddsLimit?: number;
    } = {}
  ): Promise<{ count: number; oddsCount: number; data: AiscoreDayCardMatch[] }> {
    const date = dateStr.replace(/-/g, '');
    const res = await runBridge<AiscoreDayCardMatch[]>({
      action: 'day_card',
      date,
      upcoming: opts.upcoming ?? true,
      limit: opts.limit || 0,
      with_odds: opts.withOdds ?? true,
      odds_limit: opts.oddsLimit ?? 12,
    });
    if (!res.ok) {
      throw new Error(`[AiScore] day_card: ${res.error || 'failed'}`);
    }
    const data = (res.data || []) as AiscoreDayCardMatch[];
    return {
      count: res.count ?? data.length,
      oddsCount: res.oddsCount ?? data.filter((m) => m.odds).length,
      data,
    };
  }

  public async getMatchOdds(
    matchId: string
  ): Promise<{ home: number; draw: number; away: number } | null> {
    const res = await runBridge<{ home: number; draw: number; away: number }>({
      action: 'odds',
      match_id: matchId,
    });
    if (!res.ok) return null;
    return (res.data as { home: number; draw: number; away: number }) || null;
  }

  public async getMatchData(matchId: string): Promise<ScoutPayload> {
    return this.getScout(matchId);
  }

  public async getMatchHistory(matchId: string): Promise<unknown> {
    const res = await runBridge({ action: 'history', match_id: matchId });
    return unwrap(res);
  }

  /**
   * Placar REAL via match/data — fonte da verdade para resolver bilhetes.
   * Retorna null se o jogo ainda não terminou ou sem placar FT.
   */
  public async getLiveResult(matchId: string): Promise<AiscoreLiveResult | null> {
    const res = await runBridge<AiscoreLiveResult>({ action: 'live_result', match_id: matchId });
    if (!res.ok) return null;
    return (res.data as AiscoreLiveResult) || null;
  }

  public async getScout(matchId: string): Promise<ScoutPayload> {
    const res = await runBridge<ScoutPayload>({ action: 'scout', match_id: matchId });
    return unwrap(res);
  }

  public async resolveMatchId(
    home: string,
    away: string,
    date: string
  ): Promise<AiscoreMatchMeta | null> {
    const res = await runBridge<AiscoreMatchMeta>({
      action: 'resolve',
      home,
      away,
      date,
    });
    if (!res.ok) return null;
    return res.data || null;
  }

  public async getTeamHistory(teamId: string, n = 10): Promise<unknown> {
    const res = await runBridge({ action: 'team_history', team_id: teamId, n });
    return unwrap(res);
  }

  public async getStandings(compId: string, seasonId = ''): Promise<unknown> {
    const res = await runBridge({
      action: 'standings',
      comp_id: compId,
      season_id: seasonId,
    });
    return unwrap(res);
  }

  /**
   * Resolve AiScore match_id for a market match (team names + calendar date)
   * and return the FULL scout payload (all AiScore variables).
   * Cached 6h on disk + memory.
   *
   * [AS-3] Deduplicação de pedidos em voo + cache negativa: o mesmo jogo
   * pedido em simultâneo pela passagem síncrona e pela de background gerava
   * dois spawns do bridge; e um jogo sem scout (liga menor) era repedido em
   * TODOS os ciclos, consumindo o orçamento (1,7 s por tentativa).
   */
  public async getScoutForMatch(match: MatchItem): Promise<ScoutPayload | null> {
    // dateStr from marketService is pt-PT (dd/mm/yyyy) — bridge needs YYYY-MM-DD.
    const dateKey = aiscoreDayKey(match.kickoffAt);
    const key = cacheKey(match.home, match.away, dateKey);
    const cache = loadCache();
    const hit = cache[key];
    if (fresh(hit) && hit.scout) {
      // [AS-6] O contexto é derivado do scout: não se guarda duplicado.
      const kickoffMs = match.kickoffAt || parseKickoffMs((hit.scout as ScoutPayload).kickoff);
      hit.context = scoutToMatchContext(hit.scout as ScoutPayload, kickoffMs);
      return hit.scout as ScoutPayload;
    }

    // [AS-3] Cache negativa: este jogo já falhourecentemente.
    if ((negativeScout.get(key) ?? 0) > Date.now()) return null;
    // [AS-3] Pedido em voo: devolve a mesma promessa.
    const running = inflightScout.get(key);
    if (running) return running;

    const p = this.fetchScoutForMatch(match, key).then((scout) => {
      if (!scout) negativeScout.set(key, Date.now() + NEGATIVE_TTL_MS);
      return scout;
    }).finally(() => {
      inflightScout.delete(key);
    });
    inflightScout.set(key, p);
    return p;
  }

  /** Corpo de `getScoutForMatch` (sem dedup: quem chama é o dono do pedido). */
  private async fetchScoutForMatch(
    match: MatchItem,
    key: string
  ): Promise<ScoutPayload | null> {
    const cache = loadCache();
    const hit = cache[key];
    const dateKey = aiscoreDayKey(match.kickoffAt);

    // day_card ids are `aiscore_<match_id>` — skip resolve (saves +1.7s spawn).
    const embeddedId = match.id.startsWith('aiscore_') ? match.id.slice('aiscore_'.length) : undefined;
    let aiscoreId = embeddedId || (fresh(hit) ? hit.aiscoreMatchId : undefined);
    if (!aiscoreId) {
      const meta = await this.resolveMatchId(match.home, match.away, dateKey);
      if (!meta?.match_id) {
        return null;
      }
      aiscoreId = meta.match_id;
    }

    const scout = await this.getScout(aiscoreId);
    const kickoffMs = match.kickoffAt || parseKickoffMs(scout.kickoff);

    // [AS-6] Merge (e não substituição): a entrada pode já ter `tables`/
    // `lineups`/`advanced` e não se perdem.
    cache[key] = {
      ...(hit || {}),
      at: Date.now(),
      aiscoreMatchId: aiscoreId,
      context: scoutToMatchContext(scout, kickoffMs),
      scout,
    };
    saveCache();
    return scout;
  }

  /**
   * Resolve AiScore match_id for a market match (team names + calendar date)
   * and build MatchContext. Cached 6h on disk + memory.
   */
  public async getContextForMatch(match: MatchItem): Promise<MatchContext | null> {
    const scout = await this.getScoutForMatch(match);
    if (!scout) return null;
    const kickoffMs = match.kickoffAt || parseKickoffMs(scout.kickoff);
    return scoutToMatchContext(scout, kickoffMs);
  }

  /** Extras (tables/lineups) já em cache para o jogo, sem chamadas. */
  private getCachedExtras(match: MatchItem): { tables?: any; lineups?: any } {
    try {
      const key = cacheKey(match.home, match.away, aiscoreDayKey(match.kickoffAt));
      const hit = loadCache()[key];
      if (fresh(hit)) return { tables: hit.tables, lineups: hit.lineups };
    } catch {
      /* ignora */
    }
    return {};
  }

  /** Funde patch (advanced/tables/lineups) na entrada de cache do jogo. */
  private updateCacheEntry(match: MatchItem, patch: Partial<CacheEntry>): void {
    try {
      const key = cacheKey(match.home, match.away, aiscoreDayKey(match.kickoffAt));
      const cache = loadCache();
      const hit = cache[key];
      if (hit) {
        cache[key] = { ...hit, ...patch };
        saveCache();
      }
    } catch {
      /* cache é bónus */
    }
  }

  public async getAdvanced(matchId: string): Promise<any | null> {
    const res = await runBridge<any>({ action: 'advanced', match_id: matchId });
    if (!res.ok) return null;
    return (res.data as any) || null;
  }

  public async getTables(matchId: string, compId?: string, seasonId?: string): Promise<any | null> {
    const res = await runBridge<any>({
      action: 'tables', match_id: matchId,
      comp_id: compId || '', season_id: seasonId || '',
    });
    if (!res.ok) return null;
    return (res.data as any) || null;
  }

  public async getLineups(matchId: string): Promise<any | null> {
    const res = await runBridge<any>({ action: 'lineups', match_id: matchId });
    if (!res.ok) return null;
    return (res.data as any) || null;
  }

  /**
   * Dispara o enriquecimento em background SEM empilhar: se já houver um
   * a correr, ignora o novo pedido (o próximo ciclo volta a tentar). Isto
   * impede que vários passes de 40 jogos se acumulem na fila do bridge
   * Python, que era o que mantinha o CPU permanentemente ocupado.
   */
  public enrichInBackground(
    matches: MatchItem[],
    opts?: { maxMatches?: number; deadlineMs?: number; includeLineups?: boolean }
  ): void {
    if (!ENRICH_BACKGROUND_ENABLED) return;
    if (this.backgroundEnrich) return;
    this.backgroundEnrich = this.enrichMatches(matches, {
      maxMatches: opts?.maxMatches ?? ENRICH_BACKGROUND_MAX,
      deadlineMs: opts?.deadlineMs ?? ENRICH_BACKGROUND_DEADLINE_MS,
      includeLineups: opts?.includeLineups ?? false,
    })
      .catch(() => 0)
      .finally(() => {
        this.backgroundEnrich = null;
      });
  }

  /** true enquanto um enriquecimento em background está a decorrer. */
  public isEnrichingInBackground(): boolean {
    return this.backgroundEnrich !== null;
  }

  /**
   * Attach full AiScore scout (ALL variables) + MatchContext to matches
   * with context=null (serialized). Budgeted so ticket generation never
   * waits on 40× bridge spawns. When budget remains, a second pass pulls
   * `advanced` (goal windows, trend_sc, team/h2h stats) for matches that
   * already carry a scout — the local engine uses them when present.
   */
  public async enrichMatches(
    matches: MatchItem[],
    opts?: { maxMatches?: number; deadlineMs?: number; includeLineups?: boolean }
  ): Promise<number> {
    const maxMatches = opts?.maxMatches ?? ENRICH_MAX_MATCHES;
    const deadlineMs = opts?.deadlineMs ?? ENRICH_DEADLINE_MS;
    const includeLineups = opts?.includeLineups ?? false;
    const startedAt = Date.now();
    // [AS-1] Um dado que já foi pedido e não existe não se pede outra vez a
    // cada ciclo: `advanced`/`tables` são re-pedidos para sempre quando a
    // API devolve `null` (e `null` é falsy).
    const RECHECK_MS = Math.max(60_000, envInt('AISCORE_RECHECK_MINUTES', 60) * 60_000);
    const due = (t?: number): boolean => !t || Date.now() - t > RECHECK_MS;

    // [AS-2] Preferir day_card matches (known id → single scout call) e, de
    // seguida, os jogos mais próximos: um jogo que falha às 03:00 não pode
    // ficar sempre à frente da fila.
    const pending = matches
      .filter((m) => (!m.context || !m.scout) && due(m.enrichFailedAt))
      .sort(
        (a, b) =>
          Number(b.id.startsWith('aiscore_')) - Number(a.id.startsWith('aiscore_')) ||
          a.kickoffAt - b.kickoffAt
      );

    let enriched = 0;
    // [AS-2] Disjuntor: se o Cloudflare bloquear, o ciclo percorre todos os
    // jogos a 1,7 s cada. Quatro falhas seguidas → para.
    let consecutiveFails = 0;
    for (const m of pending) {
      if (enriched >= maxMatches) break;
      if (Date.now() - startedAt > deadlineMs) break;
      try {
        const scout = await this.getScoutForMatch(m);
        if (scout) {
          m.scout = scout;
          m.advanced = (scout as ScoutPayload).advanced ?? null;
          const kickoffMs = m.kickoffAt || parseKickoffMs(scout.kickoff);
          m.context = scoutToMatchContext(scout, kickoffMs);
          m.sourceProvider = m.sourceProvider || 'aiscore';
          m.enrichFailedAt = undefined;
          const extras = this.getCachedExtras(m);
          if (!m.tables && extras.tables) m.tables = extras.tables;
          if (!m.lineups && extras.lineups) m.lineups = extras.lineups;
          enriched += 1;
          consecutiveFails = 0;
        } else {
          m.enrichFailedAt = Date.now();
          consecutiveFails += 1;
          if (consecutiveFails >= 4) break;
        }
      } catch (err: any) {
        m.enrichFailedAt = Date.now();
        consecutiveFails += 1;
        console.warn(`[AiScore] enrich failed for ${m.home} vs ${m.away}:`, err?.message);
        if (consecutiveFails >= 4) break;
      }
    }
    // Second pass: advanced variables (goal windows etc.) while budget lasts.
    // Only for aiscore_ ids (no resolve needed → 1 bridge call each).
    // Then tables (standings) + lineups (escalações/desfalques) for matches
    // that already carry scout+advanced — o motor local usa-os quando presentes.
    if (Date.now() - startedAt < deadlineMs) {
      const needAdv = matches.filter(
        (m) => m.scout && !m.advanced && m.id.startsWith('aiscore_') && due(m.advancedCheckedAt)
      );
      for (const m of needAdv) {
        if (Date.now() - startedAt > deadlineMs) break;
        // [AS-1] Marca ANTES do pedido: se falhar, não se repete no ciclo
        // seguinte.
        m.advancedCheckedAt = Date.now();
        try {
          const adv = await this.getAdvanced(m.id.slice('aiscore_'.length));
          if (adv) {
            m.advanced = adv;
            this.updateCacheEntry(m, { scout: { ...((m.scout as any) || {}), advanced: adv } });
            enriched += 1;
          }
        } catch {
          /* advanced é bónus — o motor usa o scout na mesma */
        }
      }
    }
    if (Date.now() - startedAt < deadlineMs) {
      const needExtra = matches.filter(
        (m) =>
          m.scout &&
          m.id.startsWith('aiscore_') &&
          ((!m.tables && due(m.tablesCheckedAt)) || (includeLineups && !m.lineups))
      );
      for (const m of needExtra) {
        if (Date.now() - startedAt > deadlineMs) break;
        const aiscoreId = m.id.slice('aiscore_'.length);
        try {
          if (!m.tables) {
            m.tablesCheckedAt = Date.now();
            const seasonId = firstSeasonId(m.advanced) || firstSeasonId((m.scout as any)?.advanced);
            const tables = await this.getTables(
              aiscoreId, (m.scout as any)?.competition_id, seasonId || undefined);
            if (tables) {
              m.tables = tables;
              this.updateCacheEntry(m, { tables });
              enriched += 1;
            }
          }
          if (includeLineups && !m.lineups && Date.now() - startedAt < deadlineMs) {
            const lineups = await this.getLineups(aiscoreId);
            if (lineups) {
              m.lineups = lineups;
              this.updateCacheEntry(m, { lineups });
              enriched += 1;
            }
          }
        } catch {
          /* tables/lineups são bónus — o motor usa o scout na mesma */
        }
      }
    }
    return enriched;
  }
}

export const aiscoreClient = new AiscoreService();
