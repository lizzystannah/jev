/**
 * Motor de automação por progressões.
 *
 * Uma progressão gera fichas sequenciais (níveis) com a faixa de odds definida pelo utilizador e
 * coloca-as na Premier Bet com dinheiro real e ajusta o valor da ficha
 * seguinte conforme o modo escolhido:
 *   - fixo   : valor base em todos os níveis;
 *   - total  : base + 100% do lucro do nível anterior;
 *   - metade : base + 50% do lucro anterior;
 *   - soros  : base + percentagem definida pelo utilizador.
 *
 * Se uma ficha perder (ou expirar), o ciclo reinicia no nível 1 com o valor
 * base. Ao atingir o nível máximo, também recomeça no nível 1 e continua —
 * apenas o botão Stop interrompe.
 *
 * As submissões são serializadas para nunca abrir duas sessões da Premier Bet
 * em paralelo.
 */

import { bilheteriaDb } from './db.js';
import { ticketEngine } from './ticketEngine.js';
import {
  premierBetStatus,
  uploadSlipToPremierBet,
} from './premierbet.js';
import type {
  BetSlip,
  Progression,
  ProgressionMode,
  ProgressionRun,
  ProgressionStatus,
  SlipScope,
  SlipTier,
} from './types.js';

const TICK_MS = Math.max(10_000, Number(process.env.PROGRESSION_TICK_MS || 20_000));
const MAX_RUNS_KEPT = 500;

const TIERS_AUTOMATION: Array<Exclude<SlipTier, 'maluca'>> = [
  'segura',
  'moderada',
  'ousada',
];

export interface CreateProgressionInput {
  name?: string;
  engine: 'local' | 'jev';
  tier: Exclude<SlipTier, 'maluca'>;
  scope: SlipScope;
  mode: ProgressionMode;
  baseStake: number;
  reinvestPct?: number;
  maxLevel: number;
  targetOddsMin?: number;
  targetOddsMax?: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function defaultReinvestPct(mode: ProgressionMode, custom?: number): number {
  if (mode === 'fixo') return 0;
  if (mode === 'total') return 100;
  if (mode === 'metade') return 50;
  const pct = Number(custom);
  return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 50;
}

class ProgressionEngine {
  private items = new Map<string, Progression>();
  private counter = 0;
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private tickScheduled = false;
  private initialised = false;

  // ------------------------------------------------------------- lifecycle ---

  public async init(): Promise<void> {
    if (this.initialised) return;
    const loaded = await bilheteriaDb.loadProgressions();
    for (const progression of loaded) {
      this.items.set(progression.id, progression);
      const match = /^PRG-(\d+)$/.exec(progression.id);
      if (match) this.counter = Math.max(this.counter, Number(match[1]));
    }
    this.counter = Math.max(
      this.counter,
      Number(bilheteriaDb.getMeta('progression_counter') || 0)
    );
    this.initialised = true;
    console.log(`[Progressões] Motor pronto (${this.items.size} configuração(ões)).`);
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    void this.tick();
    console.log(`[Progressões] Automação ativa (tick ${Math.round(TICK_MS / 1000)}s).`);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  // ------------------------------------------------------------------- CRUD ---

  public list(): Progression[] {
    return Array.from(this.items.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((p) => ({
        ...p,
        runs: [...p.runs].sort((a, b) => b.createdAt - a.createdAt),
      }));
  }

  public get(id: string): Progression | null {
    const progression = this.items.get(id);
    return progression ? { ...progression, runs: [...progression.runs] } : null;
  }

  public create(input: CreateProgressionInput): Progression {
    const engine = input.engine === 'jev' ? 'jev' : 'local';
    const tier = TIERS_AUTOMATION.includes(input.tier) ? input.tier : 'moderada';
    const scope: SlipScope =
      input.scope === '2_3_dias' || input.scope === 'longo' ? input.scope : 'dia';
    const mode: ProgressionMode = ['fixo', 'total', 'metade', 'soros'].includes(input.mode)
      ? input.mode
      : 'fixo';

    const baseStake = round2(Number(input.baseStake));
    if (!Number.isFinite(baseStake) || baseStake <= 0) {
      throw new Error('Indique um valor base válido (em Kwanzas).');
    }

    const maxLevel = Math.floor(Number(input.maxLevel));
    if (!Number.isFinite(maxLevel) || maxLevel < 1 || maxLevel > 100) {
      throw new Error('O nível máximo deve estar entre 1 e 100.');
    }

    const min = round2(Number(input.targetOddsMin));
    const max = round2(Number(input.targetOddsMax));
    if (!Number.isFinite(min) || min <= 1) {
      throw new Error('Indique uma odd mínima válida (maior que 1.00).');
    }
    if (!Number.isFinite(max) || max <= 1) {
      throw new Error('Indique uma odd máxima válida (maior que 1.00).');
    }
    if (max < min) {
      throw new Error('A odd máxima tem de ser maior ou igual à odd mínima.');
    }

    this.counter += 1;
    bilheteriaDb.setMeta('progression_counter', String(this.counter));
    const id = `PRG-${String(this.counter).padStart(4, '0')}`;
    const now = Date.now();

    const progression: Progression = {
      id,
      name: (input.name || '').trim() || `Progressão ${this.counter}`,
      engine,
      tier,
      scope,
      mode,
      baseStake,
      reinvestPct: defaultReinvestPct(mode, input.reinvestPct),
      maxLevel,
      targetOddsMin: min,
      targetOddsMax: max,
      status: 'pausada',
      currentLevel: 1,
      currentStake: baseStake,
      lastProfit: 0,
      totalProfit: 0,
      cycles: 0,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastError: null,
      runs: [],
    };

    this.items.set(id, progression);
    this.save(progression);
    console.log(
      `[Progressões] ${id} criada: ${engine}/${tier}/${scope}/${mode}, base ${baseStake} Kz, ` +
        `níveis ${maxLevel}, odds ${min}-${max}.`
    );
    return progression;
  }

  public play(id: string): Progression | null {
    const progression = this.items.get(id);
    if (!progression) return null;
    progression.status = 'ativa';
    progression.lastError = null;
    progression.updatedAt = Date.now();
    this.save(progression);
    // A geração + colocação real pode demorar; corre em background e a UI
    // acompanha pelo polling. Assim o pedido HTTP não fica preso.
    void this.enqueue(() => this.process(progression));
    return this.get(id);
  }

  public pause(id: string): Progression | null {
    const progression = this.items.get(id);
    if (!progression) return null;
    progression.status = 'pausada';
    progression.updatedAt = Date.now();
    this.save(progression);
    return this.get(id);
  }

  public delete(id: string): boolean {
    if (!this.items.has(id)) return false;
    this.items.delete(id);
    bilheteriaDb.deleteProgression(id);
    return true;
  }

  // ------------------------------------------------------------------- tick ---

  public tick(): Promise<void> {
    if (this.tickScheduled) return Promise.resolve();
    this.tickScheduled = true;
    return this.enqueue(async () => {
      try {
        for (const progression of this.items.values()) {
          await this.process(progression);
        }
      } finally {
        this.tickScheduled = false;
      }
    });
  }

  /**
   * 1. Fecha o resultado da ficha pendente (se já resolveu).
   * 2. Se estiver ativa e não houver ficha pendente, gera e coloca a próxima.
   */
  private async process(progression: Progression): Promise<void> {
    try {
      await this.settlePending(progression);
      if (progression.status !== 'ativa') return;
      if (progression.runs.some((run) => run.status === 'pendente')) return;
      await this.launchNext(progression);
    } catch (err: any) {
      progression.status = 'erro';
      progression.lastError = err?.message || 'Falha inesperada na automação.';
      progression.updatedAt = Date.now();
      this.save(progression);
      console.warn(`[Progressões] ${progression.id}: ${progression.lastError}`);
    }
  }

  private async settlePending(progression: Progression): Promise<void> {
    const run = progression.runs.find((item) => item.status === 'pendente');
    if (!run) return;

    const slip = ticketEngine.getSlipById(run.slipId);
    if (!slip) {
      run.status = 'falhou';
      run.profit = 0;
      run.message = 'Ficha local não encontrada.';
      progression.status = 'erro';
      progression.lastError = run.message;
      progression.updatedAt = Date.now();
      this.save(progression);
      return;
    }
    if (slip.status === 'pendente') return;

    const upload = bilheteriaDb.getUpload(run.slipId);

    // Sem registo fiável de colocação (crash/restart a meio, submissão por
    // confirmar ou falhada): não se assume nem ganho nem perda. A progressão
    // pára para o utilizador verificar as apostas abertas na Premier Bet.
    if (
      !upload ||
      upload.status === 'in_progress' ||
      upload.status === 'unknown' ||
      upload.status === 'failed' ||
      upload.status === 'dry_run'
    ) {
      run.status = 'falhou';
      run.profit = 0;
      run.resolvedAt = Date.now();
      run.message =
        'Submissão à Premier Bet por confirmar. Verifique as apostas abertas antes de retomar.';
      progression.status = 'erro';
      progression.lastError = run.message;
      progression.updatedAt = Date.now();
      this.save(progression);
      return;
    }

    if (upload.betId) run.betId = upload.betId;
    run.resolvedAt = slip.resolvedAt ?? Date.now();

    if (slip.status === 'ganhou') {
      const profit = round2(run.stake * (run.odds - 1));
      run.status = 'ganhou';
      run.profit = profit;
      progression.lastProfit = profit;
      progression.totalProfit = round2(progression.totalProfit + profit);
      this.advanceAfterWin(progression, profit);
      console.log(
        `[Progressões] ${progression.id} N${run.level}: GANHOU ${profit.toFixed(2)} Kz. ` +
          `Próximo nível ${progression.currentLevel} (${progression.currentStake} Kz).`
      );
    } else {
      run.status = slip.status === 'expirado' ? 'expirado' : 'perdeu';
      run.profit = -run.stake;
      progression.lastProfit = -run.stake;
      progression.totalProfit = round2(progression.totalProfit - run.stake);
      this.resetCycle(progression);
      console.log(
        `[Progressões] ${progression.id} N${run.level}: ${run.status.toUpperCase()} ` +
          `(-${run.stake} Kz). Ciclo reiniciado no nível 1.`
      );
    }

    progression.updatedAt = Date.now();
    this.save(progression);
  }

  private advanceAfterWin(progression: Progression, profit: number): void {
    if (progression.currentLevel >= progression.maxLevel) {
      progression.currentLevel = 1;
      progression.currentStake = progression.baseStake;
      progression.cycles += 1;
      return;
    }
    progression.currentLevel += 1;
    progression.currentStake = round2(
      progression.baseStake + (progression.reinvestPct / 100) * profit
    );
  }

  private resetCycle(progression: Progression): void {
    progression.currentLevel = 1;
    progression.currentStake = progression.baseStake;
  }

  private async launchNext(progression: Progression): Promise<void> {
    const status = premierBetStatus();
    if (!status.configured) {
      throw new Error(
        'Credenciais da Premier Bet não configuradas (PREMIERBET_LOGIN / PREMIERBET_PASSWORD).'
      );
    }
    if (!status.scriptExists) {
      throw new Error('Bridge da Premier Bet não encontrado no servidor.');
    }
    if (status.dryRun) {
      throw new Error(
        'A execução está em modo de teste (PREMIERBET_DRY_RUN). Desative para apostas reais.'
      );
    }

    const stake = round2(progression.currentStake);
    if (!Number.isFinite(stake) || stake <= 0) {
      throw new Error('Valor de aposta inválido para o próximo nível.');
    }

    const slip = await ticketEngine.generateProgressionSlip({
      scope: progression.scope,
      tier: progression.tier,
      engine: progression.engine,
      oddsMin: progression.targetOddsMin,
      oddsMax: progression.targetOddsMax,
    });

    if (!slip) {
      throw new Error(
        `Sem ficha com odds entre ${progression.targetOddsMin.toFixed(2)} e ` +
          `${progression.targetOddsMax.toFixed(2)} para ${progression.tier}/${progression.scope}.`
      );
    }

    slip.progressionId = progression.id;
    slip.progressionLevel = progression.currentLevel;
    slip.customTitle = `${progression.name} · N${progression.currentLevel} · ${slip.combinedOdds.toFixed(2)}x`;
    bilheteriaDb.upsertSlip(slip);

    const run: ProgressionRun = {
      level: progression.currentLevel,
      slipId: slip.id,
      stake,
      odds: slip.combinedOdds,
      status: 'pendente',
      profit: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    progression.runs.push(run);
    if (progression.runs.length > MAX_RUNS_KEPT) {
      progression.runs.splice(0, progression.runs.length - MAX_RUNS_KEPT);
    }
    progression.lastRunAt = Date.now();
    progression.updatedAt = Date.now();
    this.save(progression);

    bilheteriaDb.saveUpload({
      slipId: slip.id,
      status: 'in_progress',
      stake,
      message: `${progression.id} N${run.level}: submissão em curso...`,
      at: Date.now(),
    });
    try {
      await bilheteriaDb.flush();
    } catch {
      /* write-behind */
    }

    console.log(
      `[Progressões] ${progression.id} N${run.level}: ficha ${slip.id} ` +
        `(${slip.legs.length} jogos, ${slip.combinedOdds.toFixed(2)}x) a colocar com ${stake} Kz...`
    );

    let result: Awaited<ReturnType<typeof uploadSlipToPremierBet>>;
    try {
      result = await uploadSlipToPremierBet({ slip, stake, dryRun: false });
    } catch (err: any) {
      run.status = 'falhou';
      run.profit = 0;
      run.resolvedAt = Date.now();
      run.message = err?.message || 'Falha ao comunicar com a Premier Bet.';
      progression.status = 'erro';
      progression.lastError = run.message;
      progression.updatedAt = Date.now();
      this.save(progression);
      bilheteriaDb.saveUpload({
        slipId: slip.id,
        status: 'failed',
        stake,
        message: run.message,
        at: Date.now(),
      });
      return;
    }

    const placedOk = result.ok && result.placed && !result.dryRun;

    if (placedOk && result.partial) {
      this.syncPartialSlip(slip, result);
      run.odds = slip.combinedOdds;
    }

    const uploadStatus = placedOk
      ? 'placed'
      : result.unknown
      ? 'unknown'
      : 'failed';
    bilheteriaDb.saveUpload({
      slipId: slip.id,
      status: uploadStatus,
      stake: result.stake || stake,
      betId: result.betId ?? undefined,
      message: result.message,
      at: Date.now(),
    });

    run.betId = result.betId ?? undefined;
    run.message = result.message;
    run.stake = round2(result.stake || stake);

    if (!placedOk) {
      run.status = 'falhou';
      run.profit = 0;
      run.resolvedAt = Date.now();
      progression.status = 'erro';
      progression.lastError =
        result.message ||
        'A aposta não foi colocada na Premier Bet. Verifique as apostas abertas.';
      progression.updatedAt = Date.now();
      this.save(progression);
      console.warn(`[Progressões] ${progression.id} N${run.level}: ${progression.lastError}`);
      return;
    }

    progression.updatedAt = Date.now();
    this.save(progression);
    console.log(
      `[Progressões] ${progression.id} N${run.level}: aposta colocada` +
        `${result.betId ? ` (ID Premier Bet ${result.betId})` : ''}.`
    );
  }

  /** Mantém a ficha local igual ao que a Premier Bet realmente aceitou. */
  private syncPartialSlip(slip: BetSlip, result: Awaited<ReturnType<typeof uploadSlipToPremierBet>>): void {
    const norm = (s?: string) => (s || '').trim().toLowerCase();
    const okKeys = new Set(
      (result.resolved?.report || [])
        .filter((r) => r.status === 'ok')
        .map((r) => `${norm(r.home)}|${norm(r.away)}|${r.market}`)
    );
    const before = slip.legs.length;
    const kept = slip.legs.filter((leg) =>
      okKeys.has(`${norm(leg.home)}|${norm(leg.away)}|${leg.tip?.market}`)
    );
    if (kept.length === 0 || kept.length >= before) return;
    slip.legs = kept;
    slip.combinedOdds = round2(
      kept.reduce((acc, leg) => acc * (Number(leg.tip?.odds) || 1), 1)
    );
    slip.combinedProb = Number(
      (kept.reduce((acc, leg) => acc * ((Number(leg.tip?.prob) || 0) / 100), 1) * 100).toFixed(1)
    );
    slip.expiresAt = Math.min(...kept.map((leg) => leg.kickoffAt));
    bilheteriaDb.upsertSlip(slip);
  }

  private save(progression: Progression): void {
    progression.updatedAt = Date.now();
    this.items.set(progression.id, progression);
    bilheteriaDb.upsertProgression(progression);
  }

  public statusView(): Array<{
    id: string;
    name: string;
    status: ProgressionStatus;
    currentLevel: number;
    currentStake: number;
    totalProfit: number;
  }> {
    return this.list().map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      currentLevel: p.currentLevel,
      currentStake: p.currentStake,
      totalProfit: p.totalProfit,
    }));
  }
}

export const progressionEngine = new ProgressionEngine();
