/**
 * Utilitário de Gerenciamento e Formatação de Fuso Horário
 */

export interface TimezoneOption {
  id: string;
  label: string;
  offsetLabel: string;
  city: string;
}

export const TIMEZONE_OPTIONS: TimezoneOption[] = [
  { id: 'Africa/Luanda', label: 'Luanda (WAT)', offsetLabel: 'UTC+1', city: 'Luanda' },
  { id: 'Europe/Lisbon', label: 'Lisboa (WET/WEST)', offsetLabel: 'UTC+0/+1', city: 'Lisboa' },
  { id: 'Africa/Maputo', label: 'Maputo (CAT)', offsetLabel: 'UTC+2', city: 'Maputo' },
  { id: 'Africa/Sao_Tome', label: 'São Tomé (GMT)', offsetLabel: 'UTC+0', city: 'São Tomé' },
  { id: 'America/Sao_Paulo', label: 'Brasília / SP (BRT)', offsetLabel: 'UTC-3', city: 'São Paulo' },
  { id: 'Europe/London', label: 'Londres (GMT/BST)', offsetLabel: 'UTC+0/+1', city: 'Londres' },
  { id: 'UTC', label: 'Tempo Universal (UTC)', offsetLabel: 'UTC+0', city: 'UTC' },
];

const STORAGE_KEY = 'bilheteria_user_timezone';

export function getSavedTimezone(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return saved;
  } catch (e) {
    // ignore
  }

  // Se o browser estiver em UTC+1 ou África, prefere Africa/Luanda por padrão
  try {
    const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (userTz) return userTz;
  } catch (e) {
    // ignore
  }

  return 'Africa/Luanda';
}

export function saveTimezone(tz: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, tz);
  } catch (e) {
    // ignore
  }
}

/**
 * Formata um timestamp (ms) no fuso horário configurado
 */
export function formatTimeInTz(timestampMs: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('pt-PT', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    }).format(new Date(timestampMs));
  } catch (e) {
    return new Date(timestampMs).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
  }
}

export function formatDateInTz(timestampMs: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('pt-PT', {
      day: '2-digit',
      month: '2-digit',
      timeZone: timezone,
    }).format(new Date(timestampMs));
  } catch (e) {
    return new Date(timestampMs).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
  }
}

/** Data + hora completas (ex.: "22/10/2026 14:32"). */
export function formatDateTimeInTz(timestampMs: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('pt-PT', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    }).format(new Date(timestampMs));
  } catch (e) {
    return new Date(timestampMs).toLocaleString('pt-PT');
  }
}

/** Chave de calendário YYYY-MM-DD num fuso (usada para separar as fichas do dia). */
export function getDayKeyInTz(timestampMs: number, timezone = 'Africa/Luanda'): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(timestampMs));
  } catch (e) {
    return new Date(timestampMs).toISOString().slice(0, 10);
  }
}

export function formatMatchSchedule(kickoffAtMs: number, timezone: string, daysFromNow: number): string {
  const timeStr = formatTimeInTz(kickoffAtMs, timezone);
  const dateStr = formatDateInTz(kickoffAtMs, timezone);

  // Calcula a diferença em dias reais no fuso do usuário
  const nowInTz = new Date(Date.now());
  const matchInTz = new Date(kickoffAtMs);

  const nowDayStr = formatDateInTz(Date.now(), timezone);
  const matchDayStr = dateStr;

  if (nowDayStr === matchDayStr) {
    return `Hoje às ${timeStr}`;
  }

  const tomorrowMs = Date.now() + 24 * 60 * 60 * 1000;
  const tomorrowDayStr = formatDateInTz(tomorrowMs, timezone);
  if (matchDayStr === tomorrowDayStr) {
    return `Amanhã às ${timeStr}`;
  }

  return `${dateStr} às ${timeStr}`;
}
