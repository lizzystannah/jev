/**
 * Odds reais da Premier Bet (só API, sem browser) via Scraping/premierbet_odds.py.
 *
 * Usado para dar preço real aos mercados que o feed do AiScore não traz
 * (dupla chance, over/under 1.5/3.5, DNB) quando o utilizador escolhe uma tip
 * específica ou monta uma ficha manual. Devolve apenas odds existentes no
 * evento — nunca inventa preços.
 *
 * ALINHAMENTO (PB-1): o bridge pode não devolver um resultado por perna. Por
 * isso devolve `aligned`, um array 1:1 com as pernas de entrada (`null` onde
 * falhou), e quem consome usa `aligned[i]` — nunca `results[i]`, que deixa de
 * estar alinhado quando há falhas.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { MarketType } from './types.js';
import { resolvePythonBin, runPythonJson } from './pythonBridge.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, '..');
const BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'Scraping', 'premierbet_odds.py');

const PYTHON_BIN = resolvePythonBin(
  ['PREMIERBET_PYTHON', 'AISCORE_PYTHON'],
  [WORKSPACE_ROOT, PROJECT_ROOT]
);

export interface PbOddsLeg {
  home: string;
  away: string;
  kickoffAt?: number | null;
  date?: string | null;
  markets: MarketType[];
}

export interface PbOddsResult {
  /** Eco do índice da perna no pedido (o bridge devolve-o). */
  idx?: number;
  home: string;
  away: string;
  event_id: string | null;
  event: string | null;
  odds: Partial<Record<MarketType, number | null>>;
  error?: string | null;
}

export interface PbOddsResponse {
  ok: boolean;
  /** Compatibilidade: só os resultados sem buracos (NÃO usar para indexar). */
  results: PbOddsResult[];
  /** 1:1 com as pernas de entrada. `null` onde não houve odds. */
  aligned: Array<PbOddsResult | null>;
  error?: string;
}

/** Resultados em cache por ~5 min (evita martelar a API da Premier Bet). */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Erros de rede/ausência de jogo: cache negativo curto (90 s). */
const NEG_TTL_MS = 90 * 1000;

const cache = new Map<string, { at: number; value: PbOddsResult }>();
const negative = new Map<string, { at: number; error: string }>();

/**
 * Chave de cache. Inclui os mercados pedidos: um resultado só vale para os
 * mercados que o bridge foi buscar. Para não duplicar chamadas, o
 * ticketEngine pede sempre o conjunto completo (ver `ALL_MARKETS`).
 */
function cacheKey(leg: PbOddsLeg): string {
  const day = leg.date || (leg.kickoffAt ? new Date(leg.kickoffAt).toISOString().slice(0, 10) : '');
  return `${leg.home}|${leg.away}|${day}|${[...leg.markets].sort().join(',')}`;
}

/** Limpa entradas expiradas (o Map cresce sem limite caso contrário). */
function pruneCaches(now: number): void {
  for (const [key, hit] of cache) {
    if (now - hit.at >= CACHE_TTL_MS) cache.delete(key);
  }
  for (const [key, hit] of negative) {
    if (now - hit.at >= NEG_TTL_MS) negative.delete(key);
  }
}

const norm = (s?: string | null): string => (s ?? '').trim().toLowerCase();
const sameFixture = (r: PbOddsResult, l: PbOddsLeg): boolean =>
  norm(r.home) === norm(l.home) && norm(r.away) === norm(l.away);

async function doResolve(
  legs: PbOddsLeg[],
  timeoutMs: number
): Promise<PbOddsResponse> {
  const now = Date.now();
  pruneCaches(now);

  const pending: PbOddsLeg[] = [];
  const cached = new Map<string, PbOddsResult>();
  for (const leg of legs) {
    const key = cacheKey(leg);
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      cached.set(key, hit.value);
      continue;
    }
    const neg = negative.get(key);
    if (neg && now - neg.at < NEG_TTL_MS) {
      // Falha recente: não volta a bater na API (evita martelar).
      continue;
    }
    pending.push(leg);
  }

  let fresh: PbOddsResult[] = [];
  let error: string | undefined;
  if (pending.length > 0) {
    if (!fs.existsSync(BRIDGE_SCRIPT)) {
      error = `script não encontrado: ${BRIDGE_SCRIPT}`;
    } else {
      try {
        // O `idx` viaja no pedido e é ecoado pelo bridge: a associação
        // deixa de depender da ordem e do nome.
        const sent = pending.map((l, idx) => ({ ...l, idx }));
        const parsed = await runPythonJson<PbOddsResponse>(
          PYTHON_BIN,
          BRIDGE_SCRIPT,
          { legs: sent },
          { cwd: PROJECT_ROOT, timeoutMs, maxBytes: 16 * 1024 * 1024 }
        );
        if (!parsed.ok) error = parsed.error || 'falha no bridge da Premier Bet';
        fresh = parsed.results || [];
      } catch (err: any) {
        error = err?.message || 'falha ao consultar a Premier Bet';
      }
    }
  }

  // Associação por `idx` (índice do pedido). O fallback por nome só vale para
  // bridges antigos que não ecoam o `idx` — e nunca para a posição.
  const byIdx = new Map<number, PbOddsResult>();
  for (const r of fresh) {
    if (typeof r.idx === 'number') byIdx.set(r.idx, r);
  }
  pending.forEach((leg, i) => {
    const key = cacheKey(leg);
    const found = byIdx.get(i) ?? fresh.find((r) => r.idx == null && sameFixture(r, leg));
    if (!found) {
      if (!negative.has(key)) negative.set(key, { at: Date.now(), error: 'sem resultado' });
      return;
    }
    if (found.error) {
      negative.set(key, { at: Date.now(), error: String(found.error) });
      return;
    }
    // `at` = agora (e não o início da chamada): um pedido lento não expira
    // instantaneamente a cache.
    cache.set(key, { at: Date.now(), value: found });
    cached.set(key, found);
  });

  const aligned = legs.map((l) => cached.get(cacheKey(l)) ?? null);
  const results = aligned.filter((r): r is PbOddsResult => r !== null);
  return { ok: results.length > 0 || !error, results, aligned, error };
}

/**
 * Todas as chamadas ao bridge são serializadas: duas gerações concorrentes
 * não podem abrir processos Python em paralelo (o AiScore já faz isto).
 * A verificação de cache fica dentro de `doResolve`, por isso um pedido
 * duplicado que espera na fila já apanha a cache preenchida.
 */
let chain: Promise<unknown> = Promise.resolve();

export function resolvePremierBetOdds(
  legs: PbOddsLeg[],
  timeoutMs = 120_000
): Promise<PbOddsResponse> {
  const run = (): Promise<PbOddsResponse> => doResolve(legs, timeoutMs);
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}
