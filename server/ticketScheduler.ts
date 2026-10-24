/**
 * Agendador de fichas (bilhetes) â€” o "coraÃ§Ã£o" sempre ativo do backend.
 *
 * Responsabilidades:
 *  1. Todos os dias Ã  meia-noite de Angola (Africa/Luanda), cria a fornada de
 *     fichas de "Hoje" (quota configurÃ¡vel, default 4).
 *  2. MantÃ©m o estoque mÃ­nimo dos horizontes 2-3 dias (4) e longo prazo (4),
 *     repondo automaticamente quando uma ficha Ã© resolvida ou expira.
 *  3. Valida/expira fichas em background, mesmo sem nenhum browser aberto.
 *  4. MantÃ©m os dados de mercado frescos (sincronizaÃ§Ã£o periÃ³dica).
 *
 * Tudo Ã© serializado numa fila para nunca haver duas geraÃ§Ãµes concorrentes
 * (o enriquecimento AiScore Ã© caro e usa um bridge Python com throttle).
 */

import {
  EXPIRY_GRACE_HOURS,
  SCOPE_MAX_PENDING,
  SCOPE_QUOTAS,
  ticketEngine,
  type JevGenerationMeta,
} from './ticketEngine.js';
import { marketService } from './marketService.js';
import { bilheteriaDb } from './db.js';
import { DAY_TIMEZONE, getDayKey, msUntilNextMidnight } from './time.js';
import type { BetSlip, MarketType, SlipEngine, SlipScope, TicketStockStatus } from './types.js';

const SCOPES: SlipScope[] = ['dia', '2_3_dias', 'longo'];
const RETRY_THROTTLE_MS = 90 * 1000;
const MATCH_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export class TicketScheduler {
  private started = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private midnightTimer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastEnsureAttempt = new Map<SlipScope, number>();
  private lastTickAt: number | null = null;
  private lastMatchSyncAt = 0;
  private generating = false;

  // ------------------------------------------------------------------ queue ---

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(
      () => fn(),
      () => fn()
    );
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async withGeneration<T>(fn: () => Promise<T>): Promise<T> {
    this.generating = true;
    try {
      return await fn();
    } finally {
      this.generating = false;
    }
  }

  // --------------------------------------------------------------- lifecycle ---

  public start(): void {
    if (this.started) return;
    this.started = true;

    console.log(
      `[Scheduler] Ativo. Fuso ${DAY_TIMEZONE} | quotas: dia=${SCOPE_QUOTAS.dia}, 2-3d=${SCOPE_QUOTAS['2_3_dias']}, longo=${SCOPE_QUOTAS.longo} | tolerÃ¢ncia de expiraÃ§Ã£o=${EXPIRY_GRACE_HOURS}h`
    );

    // Tick de seguranÃ§a a cada minuto (tambÃ©m cobre relÃ³gios/event loop atrasados).
    this.tickTimer = setInterval(() => void this.tick('interval'), 60_000);
    this.tickTimer.unref?.();

    this.scheduleMidnight();
    void this.tick('bootstrap');
  }

  public stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.midnightTimer) clearTimeout(this.midnightTimer);
    this.tickTimer = null;
    this.midnightTimer = null;
    this.started = false;
  }

  private scheduleMidnight(): void {
    if (this.midnightTimer) clearTimeout(this.midnightTimer);
    const delay = msUntilNextMidnight() + 1500;
    this.midnightTimer = setTimeout(() => {
      void this.runDailyRollover('midnight');
      this.scheduleMidnight();
    }, delay);
    this.midnightTimer.unref?.();
  }

  // ------------------------------------------------------------------ counts ---

  /** Pendentes que contam para a quota (dia: apenas as criadas hoje em Angola). */
  public pendingCount(
    scope: SlipScope,
    referenceMs: number = Date.now(),
    engine: SlipEngine = 'local'
  ): number {
    const today = getDayKey(referenceMs);
    return ticketEngine.getSlips().filter((slip) => {
      if (slip.status !== 'pendente' || slip.scope !== scope) return false;
      if ((slip.engine ?? 'local') !== engine) return false;
      if (scope !== 'dia') return true;
      const key = slip.dayKey || getDayKey(slip.createdAt);
      return key === today;
    }).length;
  }

  public getStatus(): TicketStockStatus {
    return {
      dayKey: getDayKey(),
      timezone: DAY_TIMEZONE,
      dailyHour: 0,
      lastDailyRun: bilheteriaDb.getMeta('last_daily_run'),
      lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null,
      generating: this.generating,
      expiryGraceHours: EXPIRY_GRACE_HOURS,
      stocks: SCOPES.map((scope) => {
        const pending = this.pendingCount(scope);
        const quota = SCOPE_QUOTAS[scope];
        return {
          scope,
          pending,
          quota,
          missing: Math.max(0, quota - pending),
          maxPending: SCOPE_MAX_PENDING[scope],
        };
      }),
    };
  }

  // ------------------------------------------------------------------- ticks ---

  public tick(reason: string): Promise<void> {
    return this.enqueue(async () => {
      this.lastTickAt = Date.now();
      try {
        await this.tickNow(reason);
      } catch (err: any) {
        console.warn(`[Scheduler] Tick "${reason}" falhou:`, err?.message);
      }
    });
  }

  private async tickNow(reason: string): Promise<void> {
    // 1. Resolve estados e expira o que jÃ¡ passou do prazo.
    ticketEngine.validateSlips();

    // 2. MudanÃ§a de dia em Angola: forcÌ§a dados frescos e garante a fornada do dia.
    const today = getDayKey();
    const lastDaily = bilheteriaDb.getMeta('last_daily_run');
    if (lastDaily !== today) {
      console.log(`[Scheduler] MudanÃ§a de dia -> ${today}. A preparar fichas de Hoje...`);
      // Antes de criar as fichas do dia: validar resultados dos jogos jÃ¡
      // terminados (uma Ãºnica chamada de day card por dia, com placares).
      await this.resolveResultsBeforeDaily();
      try {
        this.lastMatchSyncAt = Date.now();
        await marketService.getMatches(true);
      } catch (err: any) {
        console.warn('[Scheduler] Refresh forÃ§ado do dia falhou:', err?.message);
      }
      await this.ensureScopeNow('dia', true);
      bilheteriaDb.setMeta('last_daily_run', today);
      console.log(`[Scheduler] Fichas de Hoje garantidas (${this.pendingCount('dia')}/${SCOPE_QUOTAS.dia}).`);
    }

    // 3. ReposiÃ§Ã£o normal das quotas (dia incluÃ­do, para cobrir falhas/expiraÃ§Ãµes).
    for (const scope of SCOPES) {
      await this.ensureScopeNow(scope, false);
    }

    // 4. MantÃ©m o mercado fresco mesmo sem browser aberto.
    if (Date.now() - this.lastMatchSyncAt > MATCH_REFRESH_INTERVAL_MS) {
      this.lastMatchSyncAt = Date.now();
      try {
        await marketService.getMatches(false);
      } catch (err: any) {
        console.warn('[Scheduler] Refresh periÃ³dico de jogos falhou:', err?.message);
      }
    }

    void reason;
  }

  private async ensureScopeNow(scope: SlipScope, ignoreThrottle: boolean): Promise<number> {
    const quota = SCOPE_QUOTAS[scope];
    let pending = this.pendingCount(scope);
    if (pending >= quota) return 0;

    const lastAttempt = this.lastEnsureAttempt.get(scope) || 0;
    if (!ignoreThrottle && Date.now() - lastAttempt < RETRY_THROTTLE_MS) return 0;

    this.lastEnsureAttempt.set(scope, Date.now());
    const missing = quota - pending;

    try {
      const result = await this.withGeneration(() =>
        ticketEngine.generateTicketsForScope(scope, undefined, { limit: missing })
      );
      pending = this.pendingCount(scope);
      if (result.generated.length > 0) {
        console.log(
          `[Scheduler] +${result.generated.length} ficha(s) "${scope}" geradas. Estoque: ${pending}/${quota}.`
        );
      } else {
        console.warn(
          `[Scheduler] Sem fichas novas para "${scope}" (mercado insuficiente). Estoque: ${pending}/${quota}.`
        );
      }
      return result.generated.length;
    } catch (err: any) {
      console.warn(`[Scheduler] GeraÃ§Ã£o "${scope}" falhou:`, err?.message);
      return 0;
    }
  }

  /** ReposiÃ§Ã£o forÃ§ada (usada no reset e apÃ³s resoluÃ§Ãµes em lote). */
  public forceRefillAll(): Promise<void> {
    return this.enqueue(async () => {
      this.lastEnsureAttempt.clear();
      ticketEngine.validateSlips();
      for (const scope of SCOPES) {
        await this.ensureScopeNow(scope, true);
      }
    });
  }

  /** Valida resultados dos jogos terminados antes de criar as fichas do dia. */
  private async resolveResultsBeforeDaily(): Promise<void> {
    try {
      const allowIds = new Set(
        ticketEngine
          .getSlips()
          .filter((slip) => slip.status === 'pendente')
          .flatMap((slip) => slip.legs.map((leg) => leg.id))
      );
      const resolved = await marketService.resolveFromDayResults({
        offsets: [0, -1, -2],
        allowIds,
      });
      if (resolved.length > 0) {
        ticketEngine.validateSlips();
        console.log(
          `[Scheduler] ${resolved.length} resultado(s) validado(s) antes das fichas do dia.`
        );
      }
    } catch (err: any) {
      console.warn('[Scheduler] Varredura de resultados antes do dia falhou:', err?.message);
    }
  }

  public runDailyRollover(reason: string): Promise<void> {
    return this.enqueue(async () => {
      const today = getDayKey();
      if (bilheteriaDb.getMeta('last_daily_run') === today) return;
      void reason;
      await this.resolveResultsBeforeDaily();
      try {
        this.lastMatchSyncAt = Date.now();
        await marketService.getMatches(true);
      } catch {
        /* best effort */
      }
      await this.ensureScopeNow('dia', true);
      bilheteriaDb.setMeta('last_daily_run', today);
    });
  }

  // -------------------------------------------------------- manual generation ---

  public generateMore(
    scope: SlipScope,
    activeLeagues?: string[],
    limit = 4,
    market?: MarketType,
    engine: SlipEngine = 'local'
  ): Promise<{
    generated: BetSlip[];
    all: BetSlip[];
    stock: TicketStockStatus;
    message: string;
    jevMeta?: JevGenerationMeta;
  }> {
    return this.enqueue(async () => {
      const pending = this.pendingCount(scope, Date.now(), engine);
      const max = SCOPE_MAX_PENDING[scope];
      const room = Math.max(0, max - pending);

      if (room <= 0) {
        return {
          generated: [],
          all: ticketEngine.getSlips(),
          stock: this.getStatus(),
          message: `Estoque de "${scope}" no limite (${pending}/${max}). Aguarde a resoluÃ§Ã£o de fichas.`,
        };
      }

      try {
        const result = await this.withGeneration(() =>
          ticketEngine.generateTicketsForScope(scope, activeLeagues, {
            limit: Math.min(Math.max(1, limit), room),
            market,
            engine,
          })
        );
        return {
          generated: result.generated,
          all: result.all,
          stock: this.getStatus(),
          message:
            result.generated.length > 0
              ? `${result.generated.length} nova(s) ficha(s) de "${scope}" geradas.`
              : `Mercado insuficiente para gerar novas fichas de "${scope}".`,
          jevMeta: result.jevMeta,
        };
      } catch (err: any) {
        return {
          generated: [],
          all: ticketEngine.getSlips(),
          stock: this.getStatus(),
          message: err?.message || 'Falha ao gerar fichas.',
        };
      }
    });
  }
}

export const ticketScheduler = new TicketScheduler();

