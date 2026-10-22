/**
 * Camada de acesso a SQL — abstrai o driver da base de dados.
 *
 * A base é escolhida por DATABASE_URL:
 *   - postgres:// ou postgresql://  -> PostgreSQL (pg)
 *   - libsql:// | https:// | file:  -> Turso / libSQL (@libsql/client)
 *   - vazio                         -> SQLite local (node:sqlite) — apenas dev
 *
 * O repositório (server/db.ts) escreve sempre com placeholders `?`; o driver
 * PostgreSQL converte-os para `$1, $2, ...`.
 */

import fs from 'fs';
import path from 'path';

export type Dialect = 'postgres' | 'sqlite';

export type QueryRow = Record<string, any>;

export interface SqlDriver {
  readonly dialect: Dialect;
  readonly description: string;
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<QueryRow[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** Converte placeholders `?` para o formato do PostgreSQL ($1, $2, ...). */
function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// --------------------------------------------------------------- PostgreSQL ---

class PostgresDriver implements SqlDriver {
  public readonly dialect: Dialect = 'postgres';
  public readonly description: string;
  private pool: any;

  constructor(private readonly url: string) {
    try {
      const parsed = new URL(url);
      this.description = `PostgreSQL (${parsed.host}${parsed.pathname})`;
    } catch {
      this.description = 'PostgreSQL';
    }
  }

  public async connect(): Promise<void> {
    const mod: any = await import('pg');
    const Pool = mod.Pool ?? mod.default?.Pool;
    this.pool = new Pool({
      connectionString: this.url,
      ssl: this.shouldUseSsl() ? { rejectUnauthorized: false } : undefined,
      max: 5,
    });
    // Sem isto, um erro de socket num cliente inativo derruba o processo.
    this.pool.on?.('error', (err: Error) => {
      console.warn('[Bilheteria DB] Erro no pool PostgreSQL:', err?.message);
    });
    // Valida a ligação já no arranque.
    try {
      await this.pool.query('SELECT 1');
    } catch (err) {
      await this.pool.end().catch(() => undefined);
      this.pool = null;
      throw err;
    }
  }

  /** SSL por omissão em hosts remotos (Neon, Supabase, RDS...). */
  private shouldUseSsl(): boolean {
    if (/sslmode=disable/i.test(this.url)) return false;
    if (/sslmode=(require|verify)/i.test(this.url)) return true;
    try {
      const host = new URL(this.url).hostname;
      return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
    } catch {
      return false;
    }
  }

  public async query(sql: string, params: unknown[] = []): Promise<QueryRow[]> {
    const res = await this.pool.query(toPgPlaceholders(sql), params as any[]);
    return (res?.rows ?? []) as QueryRow[];
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
  }
}

// ------------------------------------------------------------ Turso / libSQL ---

class LibsqlDriver implements SqlDriver {
  public readonly dialect: Dialect = 'sqlite';
  public readonly description: string;
  private client: any;

  constructor(private readonly url: string, private readonly authToken?: string) {
    try {
      const parsed = new URL(url);
      this.description = url.startsWith('file:')
        ? `libSQL local (${url.slice(5)})`
        : `Turso/libSQL (${parsed.host})`;
    } catch {
      this.description = 'Turso/libSQL';
    }
  }

  public async connect(): Promise<void> {
    const mod: any = await import('@libsql/client');
    const createClient = mod.createClient ?? mod.default?.createClient;
    this.client = createClient({ url: this.url, authToken: this.authToken });
    try {
      await this.client.execute('SELECT 1');
    } catch (err) {
      try {
        this.client?.close?.();
      } catch {
        /* ignore */
      }
      this.client = null;
      throw err;
    }
  }

  public async query(sql: string, params: unknown[] = []): Promise<QueryRow[]> {
    const res = await this.client.execute({ sql, args: params as any[] });
    return (res?.rows ?? []) as QueryRow[];
  }

  public async exec(sql: string): Promise<void> {
    // executeMultiple aceita vários statements separados por `;`.
    if (typeof this.client.executeMultiple === 'function') {
      await this.client.executeMultiple(sql);
    } else {
      await this.client.execute(sql);
    }
  }

  public async close(): Promise<void> {
    try {
      this.client?.close?.();
    } catch {
      /* ignore */
    }
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
  }
}

// ----------------------------------------------------------------- factory ---

export async function createSqlDriver(
  databaseUrl: string | undefined,
  localSqlitePath: string
): Promise<SqlDriver> {
  const url = databaseUrl?.trim();

  if (!url) {
    console.warn(
      '[Bilheteria DB] DATABASE_URL não definido — a usar SQLite local (apenas desenvolvimento). ' +
        'Em produção defina DATABASE_URL (postgres:// ou libsql://).'
    );
    return new SqliteDriver(localSqlitePath);
  }

  if (/^postgres(ql)?:\/\//i.test(url)) {
    return new PostgresDriver(url);
  }

  if (/^libsql:\/\//i.test(url) || /^https?:\/\//i.test(url) || /^file:/i.test(url)) {
    return new LibsqlDriver(url, process.env.DATABASE_AUTH_TOKEN?.trim() || undefined);
  }

  throw new Error(
    `DATABASE_URL com esquema não suportado: "${url.split(':')[0]}". Use postgres://, libsql:// ou https://.`
  );
}
