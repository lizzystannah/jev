/**
 * Camada de acesso a SQL — abstrai o driver da base de dados.
 *
 * Base de dados principal: MySQL, configurada por variáveis de ambiente:
 *   MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 *   MYSQL_SSL (opcional)
 *
 * Quando nenhuma variável MYSQL_* está definida, usa SQLite local em
 * .data/bilheteria.db apenas para desenvolvimento.
 *
 * O repositório (server/db.ts) escreve sempre com placeholders `?`, que são
 * nativos no MySQL e no SQLite.
 */

import fs from 'fs';
import path from 'path';

export type Dialect = 'mysql' | 'sqlite';

export type QueryRow = Record<string, any>;

export interface SqlDriver {
  readonly dialect: Dialect;
  readonly description: string;
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<QueryRow[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
}

/** Lê e valida a configuração MySQL a partir da env. `null` = não configurado. */
export function mysqlConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MysqlConfig | null {
  const host = env.MYSQL_HOST?.trim();
  const user = env.MYSQL_USER?.trim();
  const database = env.MYSQL_DATABASE?.trim();
  const password = env.MYSQL_PASSWORD ?? '';
  const portRaw = env.MYSQL_PORT?.trim();

  const anySet = Boolean(host || user || database);
  if (!anySet) return null;

  const missing: string[] = [];
  if (!host) missing.push('MYSQL_HOST');
  if (!user) missing.push('MYSQL_USER');
  if (!database) missing.push('MYSQL_DATABASE');
  if (missing.length > 0) {
    throw new Error(
      `Configuração MySQL incompleta: falta ${missing.join(', ')}. ` +
        'Defina MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD e MYSQL_DATABASE na env.'
    );
  }

  const port = portRaw ? Number(portRaw) : 3306;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`MYSQL_PORT inválido: "${portRaw}". Use um número entre 1 e 65535.`);
  }

  const ssl = /^(1|true|yes|on)$/i.test(env.MYSQL_SSL?.trim() ?? '');

  return { host: host!, port, user: user!, password, database: database!, ssl };
}

// --------------------------------------------------------------------- MySQL ---

class MysqlDriver implements SqlDriver {
  public readonly dialect: Dialect = 'mysql';
  public readonly description: string;
  private pool: any;

  constructor(private readonly config: MysqlConfig) {
    this.description = `MySQL (${config.host}:${config.port}/${config.database})`;
  }

  public async connect(): Promise<void> {
    const mod: any = await import('mysql2/promise');
    const createPool = mod.createPool ?? mod.default?.createPool;

    this.pool = createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      // utf8mb4 é o default do mysql2 (UTF8MB4_UNICODE_CI).
      waitForConnections: true,
      connectionLimit: 5,
      supportBigNumbers: true,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
    });

    try {
      await this.pool.query('SELECT 1');
    } catch (err) {
      try {
        await this.pool.end();
      } catch {
        /* ignore */
      }
      this.pool = null;
      throw err;
    }
  }

  public async query(sql: string, params: unknown[] = []): Promise<QueryRow[]> {
    const [rows] = await this.pool.query(sql, params as any[]);
    // INSERT/UPDATE devolvem OkPacket, não uma lista de linhas.
    return Array.isArray(rows) ? (rows as QueryRow[]) : [];
  }

  public async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  public async close(): Promise<void> {
    try {
      await this.pool?.end();
    } catch {
      /* ignore */
    }
    this.pool = null;
  }
}

// ------------------------------------------------------------ SQLite local ---

class SqliteDriver implements SqlDriver {
  public readonly dialect: Dialect = 'sqlite';
  public readonly description: string;
  private db: any;

  constructor(private readonly filePath: string) {
    this.description = `SQLite local (${filePath})`;
  }

  public async connect(): Promise<void> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const mod: any = await import('node:sqlite');
    const DatabaseSync = mod.DatabaseSync ?? mod.default?.DatabaseSync;
    this.db = new DatabaseSync(this.filePath);
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
    } catch {
      /* best effort */
    }
  }

  public async query(sql: string, params: unknown[] = []): Promise<QueryRow[]> {
    return this.db.prepare(sql).all(...(params as any[])) as QueryRow[];
  }

  public async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  public async close(): Promise<void> {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
    this.db = null;
  }
}

// ----------------------------------------------------------------- factory ---

export async function createSqlDriver(
  mysql: MysqlConfig | null,
  localSqlitePath: string
): Promise<SqlDriver> {
  if (mysql) return new MysqlDriver(mysql);

  console.warn(
    '[Bilheteria DB] MYSQL_* não configurado — a usar SQLite local (apenas desenvolvimento). ' +
      'Defina MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD e MYSQL_DATABASE na env.'
  );
  return new SqliteDriver(localSqlitePath);
}
