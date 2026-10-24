/**
 * Odds reais da Premier Bet (só API, sem browser) via Scraping/premierbet_odds.py.
 *
 * Usado para dar preço real aos mercados que o feed do AiScore não traz
 * (dupla chance, over/under 1.5/3.5, DNB) quando o utilizador escolhe uma tip
 * específica ou monta uma ficha manual. Devolve apenas odds existentes no
 * evento — nunca inventa preços.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import type { MarketType } from './types.js';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, '..');
const BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'Scraping', 'premierbet_odds.py');

function resolvePythonBin(): string {
  const configured = process.env.PREMIERBET_PYTHON?.trim();
  if (configured) return configured;
  const aiscore = process.env.AISCORE_PYTHON?.trim();
  if (aiscore) return aiscore;
  for (const candidate of [
    path.join(WORKSPACE_ROOT, '.venv312', 'Scripts', 'python.exe'),
    path.join(WORKSPACE_ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(PROJECT_ROOT, '.venv312', 'Scripts', 'python.exe'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'python3';
}

export interface PbOddsLeg {
  home: string;
  away: string;
  kickoffAt?: number | null;
  date?: string | null;
  markets: MarketType[];
}

export interface PbOddsResult {
  home: string;
  away: string;
  event_id: string | null;
  event: string | null;
  odds: Partial<Record<MarketType, number | null>>;
  error?: string | null;
}

export interface PbOddsResponse {
  ok: boolean;
  results: PbOddsResult[];
  error?: string;
}

/** Resultados em cache por ~5 min (evita martelar a API da Premier Bet). */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: PbOddsResult }>();

function cacheKey(leg: PbOddsLeg): string {
  const day = leg.date || (leg.kickoffAt ? new Date(leg.kickoffAt).toISOString().slice(0, 10) : '');
  return `${leg.home}|${leg.away}|${day}|${[...leg.markets].sort().join(',')}`;
}

export async function resolvePremierBetOdds(
  legs: PbOddsLeg[],
  timeoutMs = 120_000
): Promise<PbOddsResponse> {
  const now = Date.now();
  const pending: PbOddsLeg[] = [];
  const cached = new Map<string, PbOddsResult>();
  for (const leg of legs) {
    const key = cacheKey(leg);
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) cached.set(key, hit.value);
    else pending.push(leg);
  }

  let fresh: PbOddsResult[] = [];
  let error: string | undefined;
  if (pending.length > 0) {
    if (!fs.existsSync(BRIDGE_SCRIPT)) {
      error = `script não encontrado: ${BRIDGE_SCRIPT}`;
    } else {
      try {
        const { stdout } = await execFileAsync(
          resolvePythonBin(),
          ['-X', 'utf8', BRIDGE_SCRIPT, JSON.stringify({ legs: pending })],
          {
            cwd: PROJECT_ROOT,
            timeout: timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, PYTHONUTF8: '1' },
          }
        );
        const parsed = JSON.parse(stdout) as PbOddsResponse;
        if (!parsed.ok) error = parsed.error || 'falha no bridge da Premier Bet';
        fresh = parsed.results || [];
      } catch (err: any) {
        error = err?.message || 'falha ao consultar a Premier Bet';
      }
    }
  }

  // O bridge devolve um resultado por perna, na mesma ordem; usa o índice e,
  // se faltar, tenta pelo par de equipas.
  pending.forEach((leg, i) => {
    const found =
      fresh[i] ??
      fresh.find(
        (r) =>
          r.home?.trim().toLowerCase() === leg.home.trim().toLowerCase() &&
          r.away?.trim().toLowerCase() === leg.away.trim().toLowerCase()
      );
    if (found) {
      cache.set(cacheKey(leg), { at: now, value: found });
      cached.set(cacheKey(leg), found);
    }
  });

  const results = legs
    .map((leg) => cached.get(cacheKey(leg)))
    .filter((r): r is PbOddsResult => Boolean(r));

  return { ok: results.length > 0 || !error, results, error };
}
