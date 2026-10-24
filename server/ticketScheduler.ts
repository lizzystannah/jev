/**
 * Agendador de fichas (bilhetes) — o "coração" sempre ativo do backend.
 *
 * Responsabilidades:
 *  1. Todos os dias à meia-noite de Angola (Africa/Luanda), cria a fornada de
 *     fichas de "Hoje" (quota configurável, default 4).
 *  2. Mantém o estoque mínimo dos horizontes 2-3 dias (4) e longo prazo (4),
 *     repondo automaticamente quando uma ficha é resolvida ou expira.
 *  3. Valida/expira fichas em background, mesmo sem nenhum browser aberto.
 *  4. Mantém os dados de mercado frescos (sincronização periódica).
 *
 * Tudo é serializado numa fila para nunca haver duas gerações concorrentes
 * (o enriquecimento AiScore é caro e usa um bridge Python com throttle).
 */

import {
  EXPIRY_GRACE_HOURS,
  SCOPE_MAX_PENDING,
  SCOPE_QUOTAS,
  ticketEngine,
} from './ticketEngine.js';
import { marketService } from './marketService.js';
import { bilheteriaDb } from './db.js';
import { DAY_TIMEZONE, getDayKey, msUntilNextMidnight } from './time.js';
import type { BetSlip, MarketType, SlipScope, TicketStockStatus } from './types.js';

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
      `[Scheduler] Ativo. Fuso ${DAY_TIMEZONE} | quotas: dia=${SCOPE_QUOTAS.dia}, 2-3d=${SCOPE_QUOTAS['2_3_dias']}, longo=${SCOPE_QUOTAS.longo} | tolerância de expiração=${EXPIRY_GRACE_HOURS}h`
    );

    // Tick de segurança a cada minuto (também cobre relógios/event loop atrasados).
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
  public pendingCount(scope: SlipScope, referenceMs: number = Date.now()): number {
    const today = getDayKey(referenceMs);
    return ticketEngine.getSlips().filter((slip) => {
      if (slip.status !== 'pendente' || slip.scope !== scope) return false;
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
    // 1. Resolve estados e expira o que já passou do prazo.
    ticketEngine.validateSlips();

    // 2. Mudança de dia em Angola: força dados frescos e garante a fornada do dia.
    const today = getDayKey();
    const lastDaily = bilheteriaDb.getMeta('last_daily_run');
    if (lastDaily !== today) {
      console.log(`[Scheduler] Mudança de dia -> ${today}. A preparar fichas de Hoje...`);
      try {
        this.lastMatchSyncAt = Date.now();
        await marketService.getMatches(true);
      } catch (err: any) {
        console.warn('[Scheduler] Refresh forçado do dia falhou:', err?.message);
      }
      await this.ensureScopeNow('dia', true);
      bilheteriaDb.setMeta('last_daily_run', today);
      console.log(`[Scheduler] Fichas de Hoje garantidas (${this.pendingCount('dia')}/${SCOPE_QUOTAS.dia}).`);
    }

    // 3. Reposição normal das quotas (dia incluído, para cobrir falhas/expirações).
    for (const scope of SCOPES) {
      await this.ensureScopeNow(scope, false);
    }

    // 4. Mantém o mercado fresco mesmo sem browser aberto.
    if (Date.now() - this.lastMatchSyncAt > MATCH_REFRESH_INTERVAL_MS) {
      this.lastMatchSyncAt = Date.now();
      try {
        await marketService.getMatches(false);
      } catch (err: any) {
        console.warn('[Scheduler] Refresh periódico de jogos falhou:', err?.message);
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
      console.warn(`[Scheduler] Geração "${scope}" falhou:`, err?.message);
      return 0;
    }
  }

  /** Reposição forçada (usada no reset e após resoluções em lote). */
  public forceRefillAll(): Promise<void> {
    return this.enqueue(async () => {
      this.lastEnsureAttempt.clear();
      ticketEngine.validateSlips();
      for (const scope of SCOPES) {
        await this.ensureScopeNow(scope, true);
      }
    });
  }

  public runDailyRollover(reason: string): Promise<void> {
    return this.enqueue(async () => {
      const today = getDayKey();
      if (bilheteriaDb.getMeta('last_daily_run') === today) return;
      void reason;
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
    market?: MarketType
  ): Promise<{
    generated: BetSlip[];
    all: BetSlip[];
    stock: TicketStockStatus;
    message: string;
  }> {
    return this.enqueue(async () => {
      const pending = this.pendingCount(scope);
      const max = SCOPE_MAX_PENDING[scope];
      const room = Math.max(0, max - pending);

      if (room <= 0) {
        return {
          generated: [],
          all: ticketEngine.getSlips(),
          stock: this.getStatus(),
          message: `Estoque de "${scope}" no limite (${pending}/${max}). Aguarde a resolução de fichas.`,
        };
      }

      try {
        const result = await this.withGeneration(() =>
          ticketEngine.generateTicketsForScope(scope, activeLeagues, {
            limit: Math.min(Math.max(1, limit), room),
            market,
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
