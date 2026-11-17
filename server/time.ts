/**
 * Utilitários de tempo do agendador.
 *
 * Regra de negócio: todas as fichas do dia são criadas/renovadas no fuso
 * de Angola (Africa/Luanda, UTC+1, sem horário de verão).
 *
 * [X-3] Uma única fonte de verdade para os fusos:
 *  - APP: Africa/Luanda (UTC+1, sem DST) — dias de ficha, janelas;
 *  - AISCORE: UTC−3 — o fuso que o bridge envia ao AiScore. Um jogo às
 *    01:30 de Luanda do dia D pertence ao dia D−1 para o AiScore, e com as
 *    duas convenções o mesmo jogo recebia duas datas diferentes (a chave de
 *    cache e o `resolveMatchId` usavam uma, o sync usava a outra).
 */

export const DAY_TIMEZONE = 'Africa/Luanda';
export const APP_TZ_OFFSET_MIN = 60; // Africa/Luanda, sem DST
export const AISCORE_TZ_OFFSET_MIN = -180; // tz enviado ao bridge
const DAY_MS = 86_400_000;

/** Data-calendário (YYYY-MM-DD) de um timestamp num fuso de offset fixo. */
const keyAt = (ms: number, offMin: number): string =>
  new Date(ms + offMin * 60_000).toISOString().slice(0, 10);

/** Dia-calendário no fuso do app (Angola). */
export const appDayKey = (ms: number = Date.now()): string => keyAt(ms, APP_TZ_OFFSET_MIN);

/** Dia-calendário no fuso do AiScore (UTC−3). */
export const aiscoreDayKey = (ms: number): string => keyAt(ms, AISCORE_TZ_OFFSET_MIN);

/** Início (ms) do dia do app que contém `ms`. */
export function appDayStartMs(ms: number = Date.now()): number {
  const key = appDayKey(ms);
  return Date.parse(`${key}T00:00:00Z`) - APP_TZ_OFFSET_MIN * 60_000;
}

/**
 * Datas AiScore (YYYYMMDD) que cobrem o intervalo [fromMs, toMs].
 * De madrugada, a data D−1 da AiScore ainda tem jogos futuros: pedi-la
 * evita perder o horizonte.
 */
export function aiscoreDatesCovering(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  for (let t = fromMs; ; t += DAY_MS) {
    const k = aiscoreDayKey(Math.min(t, toMs)).replace(/-/g, '');
    if (!out.includes(k)) out.push(k);
    if (t >= toMs) break;
  }
  return out;
}

/** Devolve a data-calendário (YYYY-MM-DD) de um timestamp no fuso de Angola. */
export function getDayKey(timestampMs: number = Date.now(), timeZone: string = DAY_TIMEZONE): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(timestampMs));
  } catch {
    return new Date(timestampMs).toISOString().slice(0, 10);
  }
}

function getClockParts(timestampMs: number, timeZone: string = DAY_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(timestampMs));

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Milissegundos até a próxima meia-noite no fuso indicado. */
export function msUntilNextMidnight(
  timestampMs: number = Date.now(),
  timeZone: string = DAY_TIMEZONE
): number {
  const { hour, minute, second } = getClockParts(timestampMs, timeZone);
  const elapsedMs = ((hour * 60 + minute) * 60 + second) * 1000 + (timestampMs % 1000);
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.max(1000, dayMs - elapsedMs);
}

/** Hora local (HH:mm) no fuso indicado. */
export function formatClock(timestampMs: number, timeZone: string = DAY_TIMEZONE): string {
  try {
    return new Intl.DateTimeFormat('pt-PT', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestampMs));
  } catch {
    return new Date(timestampMs).toISOString().slice(11, 16);
  }
}
