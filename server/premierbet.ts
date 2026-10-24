/**
 * Integração com a Premier Bet (premierbet.co.ao).
 *
 * O trabalho de browser (login, boletim, colocação) é feito pelo bridge Python
 * `Scraping/premierbet_book.py` com Playwright. Este módulo:
 *   - lê a configuração/credenciais da env;
 *   - escreve um payload temporário com a ficha + valor;
 *   - executa o bridge e lê o resultado JSON;
 *   - serializa as submissões (uma de cada vez, para não misturar sessões).
 *
 * As credenciais NUNCA são escritas em ficheiros nem em argumentos: seguem
 * apenas no ambiente do processo filho.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BetSlip, PremierBetStatus, PremierBetUploadResult } from './types.js';

export interface PremierBetConfig {
  login: string;
  password: string;
  python: string;
  script: string;
  headful: boolean;
  dryRun: boolean;
  defaultStake: number;
  minStake: number;
  maxStake: number;
  timeoutMs: number;
  debugDir: string;
  noSandbox: boolean;
}

export interface PremierBetUploadOptions {
  slip: BetSlip;
  /** Valor em Kwanzas (AOA). */
  stake: number;
  dryRun?: boolean;
}

export class PremierBetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PremierBetConfigError';
  }
}

function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  return /^(1|true|yes|on|sim)$/i.test(value);
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function premierBetConfigFromEnv(): PremierBetConfig {
  const login = (process.env.PREMIERBET_LOGIN ?? process.env.PREMIERBET_USERNAME ?? '').trim();
  const password = process.env.PREMIERBET_PASSWORD ?? '';
  const python = (
    process.env.PREMIERBET_PYTHON ||
    process.env.AISCORE_PYTHON ||
    (process.platform === 'win32' ? 'python' : 'python3')
  ).trim();
  const scriptRaw =
    process.env.PREMIERBET_SCRIPT?.trim() ||
    path.join(process.cwd(), 'Scraping', 'premierbet_book.py');
  const script = path.isAbsolute(scriptRaw) ? scriptRaw : path.resolve(process.cwd(), scriptRaw);

  return {
    login,
    password,
    python,
    script,
    headful: envFlag('PREMIERBET_HEADFUL'),
    dryRun: envFlag('PREMIERBET_DRY_RUN'),
    defaultStake: Math.max(1, envNumber('PREMIERBET_DEFAULT_STAKE', 1000)),
    minStake: Math.max(1, envNumber('PREMIERBET_MIN_STAKE', 1)),
    maxStake: Math.max(0, envNumber('PREMIERBET_MAX_STAKE', 0)),
    timeoutMs: Math.max(60_000, envNumber('PREMIERBET_TIMEOUT_MS', 300_000)),
    debugDir:
      process.env.PREMIERBET_DEBUG_DIR?.trim() ||
      path.join(process.cwd(), '.data', 'premierbet'),
    noSandbox: envFlag('PREMIERBET_NO_SANDBOX'),
  };
}

export function premierBetStatus(): PremierBetStatus {
  const config = premierBetConfigFromEnv();
  return {
    configured: Boolean(config.login && config.password),
    dryRun: config.dryRun,
    headful: config.headful,
    defaultStake: config.defaultStake,
    maxStake: config.maxStake,
    minStake: config.minStake,
    scriptExists: fs.existsSync(config.script),
  };
}

interface RawBridgeResult {
  ok?: boolean;
  placed?: boolean;
  dry_run?: boolean;
  logged_in?: boolean;
  filled?: number;
  total_odds?: number | null;
  stake?: number;
  bet_id?: string | null;
  message?: string;
  detail?: string;
  unknown?: boolean;
  screenshot?: string | null;
  site?: RawBridgeResult;
  partial?: boolean;
  expected_legs?: number;
  placed_legs?: Array<{ home?: string; away?: string; market?: string }>;
  resolved?: {
    n_legs?: number;
    total_odds?: number | null;
    report?: Array<{
      home?: string;
      away?: string;
      market?: string;
      status?: string;
      pb_odd?: number | string | null;
    }>;
  } | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let uploadQueue: Promise<unknown> = Promise.resolve();

/** Serializa as submissões para não haver duas sessões/browsers em paralelo. */
export function uploadSlipToPremierBet(
  options: PremierBetUploadOptions
): Promise<PremierBetUploadResult> {
  const run = () => runUpload(options);
  const task = uploadQueue.then(run, run);
  uploadQueue = task.catch(() => undefined);
  return task;
}

async function runUpload(options: PremierBetUploadOptions): Promise<PremierBetUploadResult> {
  const config = premierBetConfigFromEnv();
  const dryRun = Boolean(options.dryRun) || config.dryRun;
  const stake = Number(options.stake);
  const startedAt = Date.now();

  if (!Number.isFinite(stake) || stake <= 0) {
    throw new Error('Valor da aposta inválido.');
  }
  if (!dryRun && (!config.login || !config.password)) {
    throw new PremierBetConfigError(
      'Credenciais da Premier Bet não configuradas. Defina PREMIERBET_LOGIN e PREMIERBET_PASSWORD na env.'
    );
  }
  if (!fs.existsSync(config.script)) {
    throw new PremierBetConfigError(
      `Bridge da Premier Bet não encontrado em ${config.script}.`
    );
  }

  const slip = options.slip;
  const safeId = slip.id.replace(/[^A-Za-z0-9._-]/g, '_');
  fs.mkdirSync(config.debugDir, { recursive: true });
  const screenshotPath = path.join(config.debugDir, `${safeId}-${startedAt}.png`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bilheteria-pb-'));
  const payloadPath = path.join(tmpDir, 'payload.json');
  const outPath = path.join(tmpDir, 'result.json');

  const payload = {
    slip: {
      id: slip.id,
      scope: slip.scope,
      tier: slip.tier,
      combinedOdds: slip.combinedOdds,
      createdAt: slip.createdAt,
      legs: slip.legs.map((leg) => ({
        id: leg.id,
        home: leg.home,
        away: leg.away,
        league: leg.league,
        kickoffAt: leg.kickoffAt,
        daysFromNow: leg.daysFromNow,
        dateStr: (leg as { dateStr?: string }).dateStr,
        tip: {
          market: leg.tip?.market,
          label: leg.tip?.label,
          odds: leg.tip?.odds,
          prob: leg.tip?.prob,
        },
      })),
    },
    stake,
    place: !dryRun,
    dry_run: dryRun,
    headful: config.headful,
    shot: screenshotPath,
  };

  fs.writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PREMIERBET_LOGIN: config.login,
    PREMIERBET_PASSWORD: config.password,
    ...(config.noSandbox ? { PREMIERBET_NO_SANDBOX: '1' } : {}),
  };

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  const append = (current: string, chunk: Buffer | string): string => {
    const next = current + chunk.toString();
    return next.length > 200_000 ? next.slice(-150_000) : next;
  };

  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    spawnError?: Error;
  }>((resolve) => {
    let settled = false;
    const finish = (value: {
      code: number | null;
      signal: NodeJS.Signals | null;
      spawnError?: Error;
    }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn(
        config.python,
        ['-X', 'utf8', config.script, '--payload', payloadPath, '--out', outPath],
        {
          cwd: process.cwd(),
          env: childEnv,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          // No Unix, cria um grupo de processos próprio para o timeout matar
          // também o Chromium (e não só o Python).
          detached: process.platform !== 'win32',
        }
      );
    } catch (err: any) {
      finish({ code: null, signal: null, spawnError: err });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      console.warn(
        `[PremierBet] Tempo esgotado (${Math.round(config.timeoutMs / 1000)}s) para a ficha ${slip.id}; a terminar o browser.`
      );
      const pid = child.pid;
      if (pid && process.platform === 'win32') {
        try {
          spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }
      } else if (pid) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, config.timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) console.log(`[PremierBet] ${line.slice(0, 600)}`);
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) console.warn(`[PremierBet] ${line.slice(0, 600)}`);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ code: null, signal: null, spawnError: err });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      finish({ code, signal });
    });
  });

  const durationMs = Date.now() - startedAt;
  const detailTail = [stderr, stdout]
    .filter(Boolean)
    .join('\n')
    .trim()
    .slice(-5000);

  let raw: RawBridgeResult | null = null;
  try {
    if (fs.existsSync(outPath)) {
      raw = JSON.parse(fs.readFileSync(outPath, 'utf8')) as RawBridgeResult;
    }
  } catch (err: any) {
    console.warn(`[PremierBet] Resultado JSON inválido (${slip.id}): ${err?.message ?? err}`);
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  if (!raw) {
    const pythonMissing = result.spawnError && (result.spawnError as NodeJS.ErrnoException).code === 'ENOENT';
    const unknown = !pythonMissing;
    const message = pythonMissing
      ? `Python não encontrado (${config.python}). Configure PREMIERBET_PYTHON/AISCORE_PYTHON.`
      : timedOut
        ? 'Tempo esgotado ao falar com a Premier Bet. Verifique as apostas abertas antes de tentar novamente.'
        : result.spawnError
          ? `Falha ao executar a automação: ${result.spawnError.message}`
          : 'A automação da Premier Bet não devolveu resultado. Verifique as apostas abertas antes de tentar novamente.';
    return {
      ok: false,
      placed: false,
      dryRun,
      loggedIn: false,
      filled: 0,
      totalOdds: null,
      stake,
      message,
      detail: detailTail,
      unknown,
      screenshot: fs.existsSync(screenshotPath) ? screenshotPath : null,
      durationMs,
    };
  }

  const site = raw.site ?? raw;
  const ok = Boolean(raw.ok ?? site.ok);
  const placed = Boolean(raw.placed ?? site.placed) && ok;
  const resultDryRun = Boolean(raw.dry_run ?? site.dry_run ?? dryRun);
  const filled = Number(raw.filled ?? site.filled ?? raw.resolved?.n_legs ?? 0) || 0;
  const totalOddsRaw = raw.total_odds ?? site.total_odds ?? raw.resolved?.total_odds ?? null;
  const totalOdds =
    totalOddsRaw == null || !Number.isFinite(Number(totalOddsRaw)) ? null : Number(totalOddsRaw);
  const resultStakeRaw = Number(raw.stake ?? site.stake ?? stake);
  const resultStake = Number.isFinite(resultStakeRaw) && resultStakeRaw > 0 ? resultStakeRaw : stake;
  const message =
    raw.message ||
    site.message ||
    (ok
      ? resultDryRun
        ? 'Boletim preenchido em modo de teste (aposta não colocada).'
        : 'Aposta colocada com sucesso.'
      : 'A aposta não foi colocada.');

  return {
    ok,
    placed,
    dryRun: resultDryRun,
    loggedIn: Boolean(raw.logged_in ?? site.logged_in),
    filled,
    totalOdds,
    stake: resultStake,
    betId: raw.bet_id ?? site.bet_id ?? null,
    message,
    detail: raw.detail || detailTail,
    unknown: Boolean(raw.unknown ?? site.unknown),
    screenshot: raw.screenshot || site.screenshot || (fs.existsSync(screenshotPath) ? screenshotPath : null),
    durationMs,
    partial: Boolean(raw.partial),
    expected_legs: raw.expected_legs,
    placed_legs: raw.placed_legs,
    resolved: raw.resolved ?? null,
  };
}

/** Pequeno helper para testes: espera que a fila de submissões termine. */
export async function waitForPremierBetQueue(): Promise<void> {
  await uploadQueue.catch(() => undefined);
  // Dá uma volta extra para incluir tarefas encadeadas depois do snapshot.
  await sleep(0);
  await uploadQueue.catch(() => undefined);
}
