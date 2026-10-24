import {
  BackendStatus,
  MatchItem,
  BetSlip,
  AiMatchAnalysis,
  TicketStockStatus,
  PremierBetStatus,
  PremierBetUploadResult,
  SlipUpload,
  TipMarket,
  SlipTier,
} from './types.js';

export async function fetchBackendStatus(): Promise<BackendStatus> {
  const res = await fetch('/api/status');
  if (!res.ok) throw new Error('Falha ao conectar com o servidor');
  return res.json();
}

export async function fetchMatches(forceRefresh = false): Promise<MatchItem[]> {
  const res = await fetch(`/api/matches${forceRefresh ? '?refresh=true' : ''}`);
  if (!res.ok) throw new Error('Falha ao carregar jogos');
  return res.json();
}

export async function fetchTickets(): Promise<BetSlip[]> {
  const res = await fetch('/api/tickets');
  if (!res.ok) throw new Error('Falha ao obter bilhetes');
  return res.json();
}

export async function fetchTicketStock(): Promise<TicketStockStatus> {
  const res = await fetch('/api/tickets/stock');
  if (!res.ok) throw new Error('Falha ao obter estoque de bilhetes');
  return res.json();
}

export async function fetchPremierBetStatus(): Promise<PremierBetStatus> {
  const res = await fetch('/api/premierbet/status');
  if (!res.ok) throw new Error('Falha ao obter estado da Premier Bet');
  return res.json();
}

export interface UploadSlipOptions {
  /** Valor em Kwanzas (AOA). */
  stake: number;
  dryRun?: boolean;
  force?: boolean;
}

export async function uploadSlip(
  slipId: string,
  options: UploadSlipOptions
): Promise<PremierBetUploadResult> {
  const res = await fetch(`/api/tickets/${encodeURIComponent(slipId)}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Falha ao subir a ficha para a Premier Bet') as Error & {
      upload?: SlipUpload;
    };
    err.upload = data.upload;
    throw err;
  }
  return data as PremierBetUploadResult;
}

export async function fetchTipMarkets(): Promise<TipMarket[]> {
  const res = await fetch('/api/tips/markets');
  if (!res.ok) throw new Error('Falha ao carregar os tipos de tip');
  return res.json();
}

export async function generateTickets(
  scope: 'dia' | '2_3_dias' | 'longo',
  leagues?: string[],
  limit = 4,
  market?: string
): Promise<{
  generated: BetSlip[];
  all: BetSlip[];
  stock?: TicketStockStatus;
  message?: string;
}> {
  const res = await fetch('/api/tickets/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, leagues, limit, market: market || undefined }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Erro ao gerar bilhetes');
  }
  return res.json();
}

export async function createCustomSlip(
  scope: 'dia' | '2_3_dias' | 'longo',
  legs: Array<{ matchId: string; market: string }>,
  tier?: SlipTier
): Promise<{ slip: BetSlip; all: BetSlip[] }> {
  const res = await fetch('/api/tickets/custom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, legs, tier }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Erro ao criar a ficha manual');
  }
  return data as { slip: BetSlip; all: BetSlip[] };
}

export async function resolveMatch(
  matchId?: string,
  resolveNextPending = false
): Promise<{ resolved: MatchItem[]; allSlips: BetSlip[] }> {
  const res = await fetch('/api/matches/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ matchId, resolveNextPending }),
  });
  if (!res.ok) throw new Error('Erro ao resolver partida');
  return res.json();
}

export async function resetMatches(): Promise<{ matches: MatchItem[]; slips: BetSlip[] }> {
  const res = await fetch('/api/matches/reset', { method: 'POST' });
  if (!res.ok) throw new Error('Erro ao reiniciar partidas');
  return res.json();
}

export async function analyzeMatchWithAi(matchId: string): Promise<AiMatchAnalysis> {
  const res = await fetch('/api/ai/analyze-match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ matchId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Erro na análise com IA');
  }
  return res.json();
}

export async function generateSmartSlipWithAi(preference?: string): Promise<{ slip: BetSlip; allSlips: BetSlip[] }> {
  const res = await fetch('/api/ai/generate-smart-slip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preference }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Erro ao gerar bilhete com IA');
  }
  return res.json();
}
