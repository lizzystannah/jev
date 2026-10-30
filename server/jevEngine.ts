/**
 * Cliente do JEV (TypeSafe) via Decisions API da OpenRouter.
 *
 * O JEV NÃO é um modelo de linguagem natural e NÃO usa chat completions.
 * Recebe um `state` + perguntas tipadas (`choice`, `noul`, `score`) e devolve
 * respostas tipadas com probabilidades/confiança:
 *
 *   POST https://openrouter.ai/api/alpha/decisions
 *   { "model": "typesafe/jev-1.14", "state": {...}, "questions": {...} }
 *
 * Aqui usamos uma pergunta `choice` por jogo: as opções são as tips candidatas
 * já calculadas pelo motor local (com probabilidade e odd real). O JEV escolhe
 * o mercado; não lhe pedimos texto nem justificação (ele não as produz).
 *
 * Docs:
 *   https://openrouter.ai/docs/guides/community/jev
 *   https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request
 */
export interface JevTipCandidate {
  market: string;
  label: string;
  prob: number;
  odds: number | null;
}

export interface JevCandidate {
  id: string;
  home: string;
  away: string;
  league: string;
  kickoff: string; // ISO ou "YYYY-MM-DD HH:mm"
  odds: Record<string, number>;
  tips: JevTipCandidate[]; // mercados com odds real, ordenados por prob desc
  /** Resumo compacto do scout: forma, H2H, tendências e hints de mercado. */
  contexto?: Record<string, unknown>;
}

export interface JevPick {
  market: string;
  confidence: number;
  reason: string;
}

/** Resultado de uma ronda de decisões (para telemetria/custo). */
export interface JevChoiceResult {
  picks: Map<string, JevPick>;
  costUsd: number;
  apiCalls: number;
}

type JevProvider = 'jev' | 'openrouter';

interface JevConfig {
  apiKey: string | null;
  endpoint: string;
  model: string;
  provider: JevProvider;
  timeoutMs: number;
  headers: Record<string, string>;
}

interface DecisionsChoiceAnswer {
  type: string;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

interface DecisionsResponse {
  id?: string;
  model?: string;
  provider?: string;
  answers?: Record<string, DecisionsChoiceAnswer>;
  usage?: { cost?: number; input_tokens?: number; output_tokens?: number };
}

const DEFAULT_JEV_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_MODEL = 'typesafe/jev-1.14';
const DEFAULT_TIMEOUT_MS = 60_000;
const BATCH_SIZE = 15;
const MAX_REASON_LENGTH = 200;
const SKIP_OPTION = 'skip';

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveProvider(endpoint: string): JevProvider {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return 'openrouter';
  } catch {
    // Endpoint inválido: tratado como proxy JEV.
  }
  return 'jev';
}

/**
 * Aceita a URL completa ou a base:
 *   https://openrouter.ai/api/alpha/decisions  (usada tal e qual)
 *   https://openrouter.ai/api/alpha            -> .../alpha/decisions
 *   https://openrouter.ai/api                  -> .../api/alpha/decisions
 *   https://openrouter.ai                      -> .../api/alpha/decisions
 *   https://proxy.exemplo/v1                   -> .../v1/alpha/decisions
 */
function normalizeEndpoint(raw?: string): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    let path = url.pathname.replace(/\/+$/, '');
    if (!path || path === '/') {
      path = '/api/alpha/decisions';
    } else if (!path.endsWith('/decisions')) {
      path = path.endsWith('/alpha') ? `${path}/decisions` : `${path}/alpha/decisions`;
    }
    url.pathname = path;
    return url.toString();
  } catch {
    return null;
  }
}

function resolveConfig(): JevConfig {
  const apiKey = readEnv('JEV_API_KEY') ?? readEnv('OPENROUTER_API_KEY') ?? null;
  // Prioridade: JEV_DECISIONS_URL > JEV_API_URL > endpoint embutido.
  const endpoint =
    normalizeEndpoint(readEnv('JEV_DECISIONS_URL')) ??
    normalizeEndpoint(readEnv('JEV_API_URL')) ??
    DEFAULT_JEV_ENDPOINT;
  const model = readEnv('JEV_MODEL') ?? DEFAULT_MODEL;
  const provider = resolveProvider(endpoint);

  const rawTimeout = Number(readEnv('JEV_TIMEOUT_MS'));
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (provider === 'openrouter') {
    const appUrl = readEnv('APP_URL');
    if (appUrl) headers['HTTP-Referer'] = appUrl;
    headers['X-OpenRouter-Title'] = 'Bilheteria JEV';
  }

  return { apiKey, endpoint, model, provider, timeoutMs, headers };
}

export function jevStatus(): {
  configured: boolean;
  model: string;
  provider: 'jev' | 'openrouter';
  endpoint: string;
} {
  const config = resolveConfig();
  return {
    configured: Boolean(config.apiKey),
    model: config.model,
    provider: config.provider,
    endpoint: config.endpoint,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST /alpha/decisions com timeout e um retry em 429/5xx. */
async function postDecisions(
  config: JevConfig,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<DecisionsResponse> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(config.endpoint, {
        method: 'POST',
        headers: config.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        lastError = new Error(
          `JEV Decisions HTTP ${res.status}: ${text.slice(0, 500)}`
        );
        if (retryable && attempt === 0) {
          await sleep(800);
          continue;
        }
        throw lastError;
      }
      let parsed: DecisionsResponse;
      try {
        parsed = JSON.parse(text) as DecisionsResponse;
      } catch {
        throw new Error(`JEV devolveu resposta inválida: ${text.slice(0, 300)}`);
      }
      if (!parsed || typeof parsed !== 'object' || !parsed.answers) {
        throw new Error('JEV devolveu resposta sem "answers".');
      }
      return parsed;
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        lastError = new Error(`JEV: tempo esgotado (${timeoutMs}ms).`);
      } else {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      if (attempt === 0) {
        await sleep(500);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error('JEV: falha desconhecida.');
}

function criteriaFor(candidate: JevCandidate): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const tip of candidate.tips) {
    const odd = tip.odds == null ? null : tip.odds;
    const oddText = odd == null ? 'sem odd' : `odd real ${odd} (implícita ${(100 / odd).toFixed(1)}%)`;
    const edge = odd == null ? null : (tip.prob / 100) * odd - 1;
    const edgeText =
      edge == null ? '' : `, EV ${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(1)}%`;
    criteria[tip.market] =
      `${tip.label} — probabilidade do motor local ${tip.prob}%, ${oddText}${edgeText}.`;
  }
  criteria[SKIP_OPTION] =
    'Nenhum dos mercados acima faz sentido face ao contexto; não escolher este jogo.';
  return criteria;
}

function clampConfidence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  // A Decisions API devolve 0..1; normalizamos para 0..100.
  return Math.round(Math.max(0, Math.min(1, n)) * 100);
}

function shortReason(pick: string, confidence: number): string {
  const text = `Decisão do JEV: ${pick} (confiança ${confidence}%).`;
  return text.length > MAX_REASON_LENGTH ? text.slice(0, MAX_REASON_LENGTH) : text;
}

/**
 * Pede ao JEV para escolher UM mercado por jogo, apenas entre as tips
 * candidatas. Devolve um Map matchId -> {market, confidence, reason}.
 * Mercados escolhidos como `skip` são omitidos.
 */
export async function jevChooseMarkets(
  candidates: JevCandidate[],
  opts?: { timeoutMs?: number }
): Promise<JevChoiceResult> {
  const config = resolveConfig();
  if (!config.apiKey) {
    throw new Error(
      'JEV não configurado: defina JEV_API_KEY (ou OPENROUTER_API_KEY) na env.'
    );
  }

  const usable = candidates.filter((c) => c.tips.length > 0);
  if (usable.length === 0) {
    return { picks: new Map(), costUsd: 0, apiCalls: 0 };
  }

  const timeoutMs = opts?.timeoutMs ?? config.timeoutMs;
  const picks = new Map<string, JevPick>();
  let totalCost = 0;
  let apiCalls = 0;

  for (let start = 0; start < usable.length; start += BATCH_SIZE) {
    const batch = usable.slice(start, start + BATCH_SIZE);
    apiCalls += 1;
    const state = {
      tarefa:
        'Escolher a melhor tip (mercado) para cada jogo de futebol, comparando a probabilidade do motor local com a odd real e validando com o contexto do jogo.',
      regras: [
        'A odd real e o EV são informação de preço; escolhe o mercado com o melhor equilíbrio entre a probabilidade local e o contexto. Não descartes um jogo só porque o EV é negativo.',
        'Valida a probabilidade local com o contexto: forma recente, H2H, média de golos, taxas de over25/BTTS e tendências.',
        'Evita under 3.5 em jogos com média de golos alta ou em que ambas as equipas marcam/sofrem com frequência.',
        'Evita mercados cuja probabilidade local esteja muito acima da odd implícita sem suporte no contexto.',
        'Não escolhas mercados sem base estatística. Usa "skip" apenas se nenhum candidato fizer sentido face ao contexto.',
      ],
      matches: batch.map((c, index) => ({
        index,
        id: c.id,
        home: c.home,
        away: c.away,
        league: c.league,
        kickoff: c.kickoff,
        contexto: c.contexto,
        candidatos: c.tips.map((t) => ({
          market: t.market,
          label: t.label,
          probabilidade_local: t.prob,
          odd_real: t.odds,
        })),
      })),
    };

    const questions: Record<string, unknown> = {};
    batch.forEach((candidate, index) => {
      questions[`q${index}`] = {
        type: 'choice',
        instructions:
          `Jogo ${candidate.home} vs ${candidate.away} (${candidate.league}), ` +
          `em state.matches[${index}]. Escolhe o mercado mais coerente com a probabilidade ` +
          `local e com state.matches[${index}].contexto. Não escolhas um mercado apenas ` +
          `por ter odd alta. Se a probabilidade local parecer exagerada face ao contexto e ` +
          `à odd implícita, escolhe outro mercado ou "${SKIP_OPTION}". Usa "${SKIP_OPTION}" ` +
          'só se nenhum candidato fizer sentido face ao contexto.',
        criteria: criteriaFor(candidate),
      };
    });

    const body = { model: config.model, state, questions };
    const response = await postDecisions(config, body, timeoutMs);
    totalCost += Number(response.usage?.cost ?? 0);

    batch.forEach((candidate, index) => {
      const answer = response.answers?.[`q${index}`];
      if (!answer || answer.type !== 'choice') return;
      const choice = typeof answer.choice === 'string' ? answer.choice.trim() : '';
      if (!choice || choice === SKIP_OPTION) return;
      // Só aceita mercados que estavam na lista deste jogo.
      if (!candidate.tips.some((t) => t.market === choice)) return;
      const confidence = clampConfidence(answer.confidence);
      picks.set(candidate.id, {
        market: choice,
        confidence,
        reason: shortReason(choice, confidence),
      });
    });
  }

  console.log(
    `[JEV] ${picks.size}/${usable.length} escolha(s) em ${apiCalls} chamada(s) — ` +
      `custo ${totalCost.toFixed(6)} USD (${config.model}).`
  );

  return { picks, costUsd: totalCost, apiCalls };
}
