import { BackendStatus, MatchItem, BetSlip, AiMatchAnalysis, TicketStockStatus } from './types.js';

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

export async function generateTickets(
  scope: 'dia' | '2_3_dias' | 'longo',
  leagues?: string[],
  limit = 2
): Promise<{
  generated: BetSlip[];
  all: BetSlip[];
  stock?: TicketStockStatus;
  message?: string;
}> {
  const res = await fetch('/api/tickets/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, leagues, limit }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Erro ao gerar bilhetes');
  }
  return res.json();
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
