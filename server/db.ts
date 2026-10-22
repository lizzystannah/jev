/**
 * Repositório de fichas (bilhetes) — a ÚNICA camada de persistência.
 *
 * A base de dados é externa/configurável por DATABASE_URL:
 *   postgres://...  -> PostgreSQL
 *   libsql://...    -> Turso / libSQL
 *   (vazio)         -> SQLite local (apenas desenvolvimento)
 *
 * O estado vive na base de dados; o processo mantém apenas uma cópia em memória
 * para leitura rápida. As escritas são serializadas numa fila (write-behind) e
 * podem ser forçadas com flush() antes de desligar.
 */

import path from 'path';
import type { BetSlip, MatchItem } from './types.js';
import { createSqlDriver, type SqlDriver } from './sqlDriver.js';

const LOCAL_DB_PATH =
  process.env.BILHETERIA_DB_PATH?.trim() || path.join(process.cwd(), '.data', 'bilheteria.db');

/** Remove anexos pesados das pernas antes de gravar. */
export function slimLeg(leg: MatchItem): MatchItem {
  const { scout, advanced, tables, lineups, context, ...rest } = leg as MatchItem & {
    scout?: unknown;
    advanced?: unknown;
    tables?: unknown;
    lineups?: unknown;
  };
  void scout;
  void advanced;
  void tables;
  void lineups;
  void context;
  return rest as MatchItem;
}

export function slimSlip(slip: BetSlip): BetSlip {
  return {
    ...slip,
    legs: slip.legs.map(slimLeg),
  };
}

const SLIP_COLUMNS =
  'id, scope, tier, status, color, legs_json, combined_odds, combined_prob, ' +
  'expires_at, created_at, resolved_at, custom_title, rationale, is_ai_generated, ' +
  'day_key, updated_at';

/** SQL do schema, parametrizado pelo dialeto (tipos BIGINT vs INTEGER). */
export function buildSchemaStatements(dialect: 'postgres' | 'sqlite'): string[] {
  const bigint = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  const real = dialect === 'postgres' ? 'DOUBLE PRECISION' : 'REAL';
  return [
    `CREATE TABLE IF NOT EXISTS slips (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      tier TEXT NOT NULL,
      status TEXT NOT NULL,
      color TEXT NOT NULL,
      legs_json TEXT NOT NULL,
      combined_odds ${real} NOT NULL,
      combined_prob ${real} NOT NULL,
      expires_at ${bigint} NOT NULL,
      created_at ${bigint} NOT NULL,
      resolved_at ${bigint},
      custom_title TEXT,
      rationale TEXT,
      is_ai_generated INTEGER NOT NULL DEFAULT 1,
      day_key TEXT,
      updated_at ${bigint} NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_slips_status ON slips(status)',
    'CREATE INDEX IF NOT EXISTS idx_slips_scope_day ON slips(scope, day_key)',
    'CREATE INDEX IF NOT EXISTS idx_slips_created ON slips(created_at)',
    `CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  ];
}

export const SLIP_UPSERT_SQL = `INSERT INTO slips (${SLIP_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    scope = excluded.scope,
    tier = excluded.tier,
    status = excluded.status,
    color = excluded.color,
    legs_json = excluded.legs_json,
    combined_odds = excluded.combined_odds,
    combined_prob = excluded.combined_prob,
    expires_at = excluded.expires_at,
    created_at = excluded.created_at,
    resolved_at = excluded.resolved_at,
    custom_title = excluded.custom_title,
    rationale = excluded.rationale,
    is_ai_generated = excluded.is_ai_generated,
    day_key = excluded.day_key,
    updated_at = excluded.updated_at`;

export const META_UPSERT_SQL = `INSERT INTO meta (key, value) VALUES (?, ?)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value`;

class BilheteriaDatabase {
  private driver: SqlDriver | null = null;
  private ready = false;
  private meta = new Map<string, string>();
  private writeQueue: Promise<void> = Promise.resolve();

  public get isReady(): boolean {
    return this.ready;
  }

  public get driverDescription(): string {
    return this.driver?.description ?? 'n/d';
  }

  // ------------------------------------------------------------------ setup ---

  public async init(): Promise<void> {
    if (this.ready) return;
    this.driver = await createSqlDriver(process.env.DATABASE_URL, LOCAL_DB_PATH);

    let lastError: any = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await this.driver.connect();
        lastError = null;
        break;
      } catch (err: any) {
        lastError = err;
        console.warn(
          `[Bilheteria DB] Ligação falhou (tentativa ${attempt}/5): ${err?.message ?? err}`
        );
        if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      }
    }
    if (lastError) {
      throw new Error(
        `Não foi possível ligar à base de dados (${this.driver.description}): ${
          lastError?.message ?? lastError
        }`
      );
    }

    await this.createSchema();
    await this.loadMeta();
    this.ready = true;
    console.log(`[Bilheteria DB] Persistência ativa: ${this.driver.description}`);
  }

  private async createSchema(): Promise<void> {
    const driver = this.requireDriver();
    for (const statement of buildSchemaStatements(driver.dialect)) {
      await driver.exec(statement);
    }
  }

  private async loadMeta(): Promise<void> {
    try {
      const rows = await this.requireDriver().query('SELECT key, value FROM meta');
      for (const row of rows) {
        if (row?.key != null) this.meta.set(String(row.key), String(row.value));
      }
    } catch (err: any) {
      console.warn('[Bilheteria DB] Falha ao carregar meta:', err?.message);
    }
  }

  // ------------------------------------------------------------------- read ---

  public async loadSlips(): Promise<BetSlip[]> {
    try {
      const rows = await this.requireDriver().query(
        'SELECT * FROM slips ORDER BY created_at ASC'
      );
      const slips: BetSlip[] = [];
      for (const row of rows) {
        try {
          const legs = JSON.parse(row.legs_json) as MatchItem[];
          if (!Array.isArray(legs)) continue;
          slips.push({
            id: String(row.id),
            scope: row.scope,
            tier: row.tier,
            color: row.color,
            legs,
            combinedOdds: Number(row.combined_odds),
            combinedProb: Number(row.combined_prob),
            expiresAt: Number(row.expires_at),
            status: row.status,
            createdAt: Number(row.created_at),
            resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
            customTitle: row.custom_title ?? undefined,
            rationale: row.rationale ?? undefined,
            isAiGenerated: Boolean(Number(row.is_ai_generated ?? 1)),
            dayKey: row.day_key ?? undefined,
          });
        } catch (err: any) {
          console.warn(`[Bilheteria DB] Registo inválido ignorado (${row.id}):`, err?.message);
        }
      }
      if (slips.length > 0) {
        console.log(`[Bilheteria DB] ${slips.length} ficha(s) restaurada(s) da base de dados.`);
      }
      return slips;
    } catch (err: any) {
      console.warn('[Bilheteria DB] Falha ao carregar fichas:', err?.message);
      return [];
    }
  }

  // ------------------------------------------------------ writes (write-behind) ---

  private enqueue(op: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(op).catch((err: any) => {
      console.warn('[Bilheteria DB] Falha de escrita:', err?.message);
    });
  }

  /** Aguarda que todas as escritas pendentes terminem. */
  public flush(): Promise<void> {
    return this.writeQueue;
  }

  public upsertSlip(slip: BetSlip): void {
    const data = slimSlip(slip);
    const params: unknown[] = [
      data.id,
      data.scope,
      data.tier,
      data.status,
      data.color,
      JSON.stringify(data.legs),
      data.combinedOdds,
      data.combinedProb,
      data.expiresAt,
      data.createdAt,
      data.resolvedAt ?? null,
      data.customTitle ?? null,
      data.rationale ?? null,
      data.isAiGenerated ? 1 : 0,
      data.dayKey ?? null,
      Date.now(),
    ];

    this.enqueue(() =>
      this.requireDriver()
        .query(SLIP_UPSERT_SQL, params)
        .then(() => undefined)
    );
  }

  public upsertMany(slips: BetSlip[]): void {
    for (const slip of slips) this.upsertSlip(slip);
  }

  public deleteAllSlips(): void {
    this.enqueue(() => this.requireDriver().query('DELETE FROM slips').then(() => undefined));
  }

  // ------------------------------------------------------------------- meta ---

  public getMeta(key: string): string | null {
    return this.meta.get(key) ?? null;
  }

  public setMeta(key: string, value: string): void {
    this.meta.set(key, value);
    this.enqueue(() =>
      this.requireDriver()
        .query(META_UPSERT_SQL, [key, value])
        .then(() => undefined)
    );
  }

  // ---------------------------------------------------------------- shutdown ---

  public async close(): Promise<void> {
    try {
      await this.writeQueue;
    } catch {
      /* ignore */
    }
    try {
      await this.driver?.close();
    } catch {
      /* ignore */
    }
    this.ready = false;
  }

  private requireDriver(): SqlDriver {
    if (!this.driver) {
      throw new Error('Base de dados não inicializada. Chame bilheteriaDb.init() no arranque.');
    }
    return this.driver;
  }
}

export const bilheteriaDb = new BilheteriaDatabase();
