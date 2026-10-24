/**
 * Repositório de fichas (bilhetes) — a ÚNICA camada de persistência.
 *
 * A base de dados é MySQL, configurada por variáveis de ambiente:
 *   MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 *
 * Sem configuração MYSQL_*, usa SQLite local em .data/bilheteria.db (apenas
 * desenvolvimento). Em produção a persistência vive só no MySQL.
 *
 * O processo mantém uma cópia em memória para leitura rápida. As escritas são
 * serializadas numa fila (write-behind) e descarregadas com flush() no shutdown.
 */

import path from 'path';
import type { BetSlip, MatchItem, SlipUpload } from './types.js';
import {
  createSqlDriver,
  mysqlConfigFromEnv,
  type Dialect,
  type SqlDriver,
} from './sqlDriver.js';

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

const SLIP_COLUMNS = [
  'id',
  'scope',
  'tier',
  'engine',
  'status',
  'color',
  'legs_json',
  'combined_odds',
  'combined_prob',
  'expires_at',
  'created_at',
  'resolved_at',
  'custom_title',
  'rationale',
  'is_ai_generated',
  'day_key',
  'updated_at',
] as const;

const SLIP_COLUMNS_SQL = SLIP_COLUMNS.join(', ');

/** Colunas atualizadas num upsert (o id é a chave e nunca muda). */
const SLIP_UPDATABLE = SLIP_COLUMNS.filter((column) => column !== 'id');

/**
 * SQL do schema, por dialeto. No MySQL os índices vivem no CREATE TABLE
 * (não existe CREATE INDEX IF NOT EXISTS); no SQLite são statements à parte.
 */
export function buildSchemaStatements(dialect: Dialect): string[] {
  if (dialect === 'mysql') {
    return [
      `CREATE TABLE IF NOT EXISTS slips (
        id VARCHAR(64) NOT NULL,
        scope VARCHAR(32) NOT NULL,
        tier VARCHAR(32) NOT NULL,
        engine VARCHAR(16) NOT NULL DEFAULT 'local',
        status VARCHAR(32) NOT NULL,
        color VARCHAR(32) NOT NULL,
        legs_json LONGTEXT NOT NULL,
        combined_odds DOUBLE NOT NULL,
        combined_prob DOUBLE NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        resolved_at BIGINT NULL,
        custom_title TEXT NULL,
        rationale TEXT NULL,
        is_ai_generated TINYINT NOT NULL DEFAULT 1,
        day_key VARCHAR(16) NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (id),
        KEY idx_slips_status (status),
        KEY idx_slips_scope_day (scope, day_key),
        KEY idx_slips_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS meta (
        meta_key VARCHAR(128) NOT NULL,
        meta_value TEXT NOT NULL,
        PRIMARY KEY (meta_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS slip_uploads (
        slip_id VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL,
        stake DOUBLE NOT NULL,
        bet_id VARCHAR(128) NULL,
        message TEXT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (slip_id),
        KEY idx_slip_uploads_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ];
  }

  return [
    `CREATE TABLE IF NOT EXISTS slips (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      tier TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'local',
      status TEXT NOT NULL,
      color TEXT NOT NULL,
      legs_json TEXT NOT NULL,
      combined_odds REAL NOT NULL,
      combined_prob REAL NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      custom_title TEXT,
      rationale TEXT,
      is_ai_generated INTEGER NOT NULL DEFAULT 1,
      day_key TEXT,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_slips_status ON slips(status)',
    'CREATE INDEX IF NOT EXISTS idx_slips_scope_day ON slips(scope, day_key)',
    'CREATE INDEX IF NOT EXISTS idx_slips_created ON slips(created_at)',
    `CREATE TABLE IF NOT EXISTS meta (
      meta_key TEXT PRIMARY KEY,
      meta_value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS slip_uploads (
      slip_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      stake REAL NOT NULL,
      bet_id TEXT,
      message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_slip_uploads_status ON slip_uploads(status)',
  ];
}

export function slipUpsertSql(dialect: Dialect): string {
  const placeholders = SLIP_COLUMNS.map(() => '?').join(', ');

  if (dialect === 'mysql') {
    const updates = SLIP_UPDATABLE.map((column) => `${column} = VALUES(${column})`).join(', ');
    return `INSERT INTO slips (${SLIP_COLUMNS_SQL}) VALUES (${placeholders})
      ON DUPLICATE KEY UPDATE ${updates}`;
  }

  const updates = SLIP_UPDATABLE.map((column) => `${column} = excluded.${column}`).join(', ');
  return `INSERT INTO slips (${SLIP_COLUMNS_SQL}) VALUES (${placeholders})
    ON CONFLICT (id) DO UPDATE SET ${updates}`;
}

export function metaUpsertSql(dialect: Dialect): string {
  return dialect === 'mysql'
    ? `INSERT INTO meta (meta_key, meta_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)`
    : `INSERT INTO meta (meta_key, meta_value) VALUES (?, ?)
       ON CONFLICT (meta_key) DO UPDATE SET meta_value = excluded.meta_value`;
}

export function slipUploadUpsertSql(dialect: Dialect): string {
  if (dialect === 'mysql') {
    return `INSERT INTO slip_uploads
      (slip_id, status, stake, bet_id, message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        stake = VALUES(stake),
        bet_id = VALUES(bet_id),
        message = VALUES(message),
        updated_at = VALUES(updated_at)`;
  }

  return `INSERT INTO slip_uploads
    (slip_id, status, stake, bet_id, message, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (slip_id) DO UPDATE SET
      status = excluded.status,
      stake = excluded.stake,
      bet_id = excluded.bet_id,
      message = excluded.message,
      updated_at = excluded.updated_at`;
}

class BilheteriaDatabase {
  private driver: SqlDriver | null = null;
  private ready = false;
  private meta = new Map<string, string>();
  private uploads = new Map<string, SlipUpload>();
  private writeQueue: Promise<void> = Promise.resolve();
  private slipUpsert = '';
  private metaUpsert = '';
  private uploadUpsert = '';

  public get isReady(): boolean {
    return this.ready;
  }

  public get driverDescription(): string {
    return this.driver?.description ?? 'n/d';
  }

  // ------------------------------------------------------------------ setup ---

  public async init(): Promise<void> {
    if (this.ready) return;

    const mysql = mysqlConfigFromEnv();
    this.driver = await createSqlDriver(mysql, LOCAL_DB_PATH);

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
    await this.migrateSchema();
    await this.loadMeta();
    await this.loadUploads();

    this.slipUpsert = slipUpsertSql(this.driver.dialect);
    this.metaUpsert = metaUpsertSql(this.driver.dialect);
    this.uploadUpsert = slipUploadUpsertSql(this.driver.dialect);
    this.ready = true;
    console.log(`[Bilheteria DB] Persistência ativa: ${this.driver.description}`);
  }

  private async createSchema(): Promise<void> {
    const driver = this.requireDriver();
    for (const statement of buildSchemaStatements(driver.dialect)) {
      await driver.exec(statement);
    }
  }

  /**
   * Migrações de colunas novas em bases já existentes. Cada ALTER é tentado
   * individualmente: se a coluna já existir, o erro é ignorado.
   */
  private async migrateSchema(): Promise<void> {
    const driver = this.requireDriver();
    const statements =
      driver.dialect === 'mysql'
        ? [
            "ALTER TABLE slips ADD COLUMN engine VARCHAR(16) NOT NULL DEFAULT 'local'",
          ]
        : ["ALTER TABLE slips ADD COLUMN engine TEXT NOT NULL DEFAULT 'local'"];
    for (const sql of statements) {
      try {
        await driver.exec(sql);
        console.log('[Bilheteria DB] Migração aplicada: slips.engine');
      } catch {
        /* coluna já existe */
      }
    }
  }

  private async loadMeta(): Promise<void> {
    try {
      const rows = await this.requireDriver().query(
        'SELECT meta_key, meta_value FROM meta'
      );
      for (const row of rows) {
        if (row?.meta_key != null) this.meta.set(String(row.meta_key), String(row.meta_value));
      }
    } catch (err: any) {
      console.warn('[Bilheteria DB] Falha ao carregar meta:', err?.message);
    }
  }

  private async loadUploads(): Promise<void> {
    try {
      const rows = await this.requireDriver().query('SELECT * FROM slip_uploads');
      const valid: SlipUpload['status'][] = [
        'in_progress',
        'placed',
        'dry_run',
        'failed',
        'unknown',
      ];
      let interrupted = 0;
      for (const row of rows) {
        const rawStatus = String(row?.status ?? '') as SlipUpload['status'];
        if (!valid.includes(rawStatus)) continue;
        const wasInProgress = rawStatus === 'in_progress';
        if (wasInProgress) interrupted += 1;
        const baseMessage = row.message == null ? undefined : String(row.message);
        this.uploads.set(String(row.slip_id), {
          slipId: String(row.slip_id),
          status: wasInProgress ? 'unknown' : rawStatus,
          stake: Number(row.stake) || 0,
          betId: row.bet_id == null ? undefined : String(row.bet_id),
          message: wasInProgress
            ? 'Submissão interrompida (servidor reiniciado). Verifique as apostas abertas na Premier Bet.'
            : baseMessage,
          at: Number(row.updated_at ?? row.created_at) || Date.now(),
        });
      }
      if (interrupted > 0) {
        console.warn(
          `[Bilheteria DB] ${interrupted} submissão(ões) Premier Bet interrompida(s) convertida(s) em "por confirmar".`
        );
      }
      if (this.uploads.size > 0) {
        console.log(`[Bilheteria DB] ${this.uploads.size} registo(s) de submissão Premier Bet restaurados.`);
      }
    } catch (err: any) {
      console.warn('[Bilheteria DB] Falha ao carregar submissões Premier Bet:', err?.message);
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
            engine: (row.engine as BetSlip['engine']) || 'local',
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
      data.engine ?? 'local',
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
        .query(this.slipUpsert, params)
        .then(() => undefined)
    );
  }

  public upsertMany(slips: BetSlip[]): void {
    for (const slip of slips) this.upsertSlip(slip);
  }

  public deleteAllSlips(): void {
    this.uploads.clear();
    this.enqueue(async () => {
      const driver = this.requireDriver();
      await driver.query('DELETE FROM slip_uploads');
      await driver.query('DELETE FROM slips');
    });
  }

  /**
   * Remove fichas específicas (e os respetivos registos de submissão).
   * Usado para descartar fichas antigas construídas com odds sintéticas que
   * nunca chegaram a ser enviadas para a Premier Bet.
   */
  public deleteSlips(ids: string[]): void {
    if (ids.length === 0) return;
    for (const id of ids) this.uploads.delete(id);
    this.enqueue(async () => {
      const driver = this.requireDriver();
      for (const id of ids) {
        await driver.query('DELETE FROM slip_uploads WHERE slip_id = ?', [id]);
        await driver.query('DELETE FROM slips WHERE id = ?', [id]);
      }
    });
  }

  // ------------------------------------------------------- premier bet uploads ---

  /** Última tentativa de subir a ficha para a Premier Bet (null se nunca tentou). */
  public getUpload(slipId: string): SlipUpload | null {
    const record = this.uploads.get(slipId);
    return record ? { ...record } : null;
  }

  public getUploads(): SlipUpload[] {
    return Array.from(this.uploads.values()).map((record) => ({ ...record }));
  }

  /** Guarda (write-behind) o resultado da tentativa de submissão. */
  public saveUpload(upload: SlipUpload): void {
    const at = Date.now();
    const record: SlipUpload = { ...upload, at };
    this.uploads.set(upload.slipId, record);
    this.enqueue(() =>
      this.requireDriver()
        .query(this.uploadUpsert, [
          record.slipId,
          record.status,
          record.stake,
          record.betId ?? null,
          record.message ?? null,
          at,
          at,
        ])
        .then(() => undefined)
    );
  }

  // ------------------------------------------------------------------- meta ---

  public getMeta(key: string): string | null {
    return this.meta.get(key) ?? null;
  }

  public setMeta(key: string, value: string): void {
    this.meta.set(key, value);
    this.enqueue(() =>
      this.requireDriver()
        .query(this.metaUpsert, [key, value])
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
