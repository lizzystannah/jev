/**
 * Cache de respostas (opcional Redis, com fallback em memória).
 *
 * O Redis só é usado se `REDIS_URL` estiver definido E o pacote `redis`
 * estiver instalado (`npm i redis`). Sem ele, tudo funciona em memória —
 * suficiente para não recalcular a lista de jogos a cada navegação de aba.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: unknown): Promise<unknown>;
  del(key: string): Promise<unknown>;
  on?(event: string, cb: (err: any) => void): unknown;
}

let redis: RedisLike | null = null;
let redisTried = false;
const memory = new Map<string, { at: number; ttlMs: number; value: string }>();

async function getRedis(): Promise<RedisLike | null> {
  if (redisTried) return redis;
  redisTried = true;
  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;
  try {
    const mod = require('redis');
    const client = mod.createClient({ url });
    client.on?.('error', (err: any) =>
      console.warn('[Cache] erro Redis:', err?.message ?? err)
    );
    await client.connect();
    redis = client as RedisLike;
    console.log('[Cache] Redis ligado:', url.replace(/\/\/[^@]*@/, '//***@'));
  } catch (err: any) {
    console.warn(
      '[Cache] Redis indisponível, a usar cache em memória:',
      err?.message ?? err
    );
    redis = null;
  }
  return redis;
}

export async function cacheGet(key: string): Promise<string | null> {
  const r = await getRedis();
  if (r) {
    try {
      const value = await r.get(key);
      if (value != null) return value;
    } catch (err: any) {
      console.warn('[Cache] get falhou:', err?.message ?? err);
    }
  }
  const hit = memory.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at < hit.ttlMs) return hit.value;
  memory.delete(key);
  return null;
}

export async function cacheSet(key: string, value: string, ttlMs = 30_000): Promise<void> {
  const r = await getRedis();
  if (r) {
    try {
      await r.set(key, value, { PX: ttlMs });
    } catch (err: any) {
      console.warn('[Cache] set falhou:', err?.message ?? err);
    }
  }
  memory.set(key, { at: Date.now(), ttlMs, value });
  if (memory.size > 40) {
    const now = Date.now();
    for (const [k, v] of memory) {
      if (now - v.at >= v.ttlMs) memory.delete(k);
    }
  }
}

export async function cacheDel(key: string): Promise<void> {
  const r = await getRedis();
  if (r) {
    try {
      await r.del(key);
    } catch {
      /* ignore */
    }
  }
  memory.delete(key);
}
