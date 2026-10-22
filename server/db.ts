/**
 * Persistência das fichas (bilhetes) em SQLite.
 *
 * Usa o módulo nativo `node:sqlite` (Node 24+) para não adicionar dependências
 * nativas. O ficheiro fica em `.data/bilheteria.db` (pode ser alterado com
 * BILHETERIA_DB_PATH).
 *
 * As pernas são guardadas como snapshot JSON, mas SEM os anexos pesados do
 * scout (scout/advanced/tables/lineups/context) — o suficiente para renderizar,
 * validar e auditar o bilhete sem inchar a base de dados.
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { BetSlip, MatchItem } from './types.js';

const DB_FILE_PATH =
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

class BilheteriaDatabase {
  private db: DatabaseSync;
  public readonly filePath: string;

  constructor() {
    this.filePath = DB_FILE_PATH;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);

    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
    } catch {
      /* pragmas são best-effort */
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS slips (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        tier TEXT NOT NULL,
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
      );

      CREATE INDEX IF NOT EXISTS idx_slips_status ON slips(status);
      CREATE INDEX IF NOT EXISTS idx_slips_scope_day ON slips(scope, day_key);
      CREATE INDEX IF NOT EXISTS idx_slips_created ON slips(created_at);

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    console.log(`[Bilheteria DB] SQLite ativo em ${this.filePath}`);
  }

  public loadSlips(): BetSlip[] {
    try {
      const rows = this.db
        .prepare('SELECT * FROM slips ORDER BY created_at ASC')
        .all() as Array<Record<string, any>>;

      const slips: BetSlip[] = [];
      for (const row of rows) {
        try {
          const legs = JSON.parse(row.legs_json) as MatchItem[];
          if (!Array.isArray(legs)) continue;
          slips.push({
            id: row.id,
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
            isAiGenerated: Boolean(row.is_ai_generated),
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

  public upsertSlip(slip: BetSlip): void {
    try {
      const data = slimSlip(slip);
      this.db
        .prepare(
          `INSERT INTO slips (
             id, scope, tier, status, color, legs_json, combined_odds, combined_prob,
             expires_at, created_at, resolved_at, custom_title, rationale,
             is_ai_generated, day_key, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
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
             updated_at = excluded.updated_at`
        )
        .run(
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
          Date.now()
        );
    } catch (err: any) {
      console.warn(`[Bilheteria DB] Falha ao gravar ficha ${slip.id}:`, err?.message);
    }
  }

  public upsertMany(slips: BetSlip[]): void {
    for (const slip of slips) this.upsertSlip(slip);
  }

  public deleteAllSlips(): void {
    try {
      this.db.exec('DELETE FROM slips;');
    } catch (err: any) {
      console.warn('[Bilheteria DB] Falha ao limpar fichas:', err?.message);
    }
  }

  public getMeta(key: string): string | null {
    try {
      const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
        | { value?: string }
        | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  public setMeta(key: string, value: string): void {
    try {
      this.db
        .prepare(
          `INSERT INTO meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .run(key, value);
    } catch (err: any) {
      console.warn(`[Bilheteria DB] Falha ao gravar meta "${key}":`, err?.message);
    }
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

export const bilheteriaDb = new BilheteriaDatabase();
