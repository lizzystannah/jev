/**
 * Utilitários de tempo do agendador.
 *
 * Regra de negócio: todas as fichas do dia são criadas/renovadas no fuso
 * de Angola (Africa/Luanda, UTC+1, sem horário de verão).
 */

export const DAY_TIMEZONE = 'Africa/Luanda';

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
