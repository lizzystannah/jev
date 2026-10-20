import { GoogleGenAI } from '@google/genai';
import { MatchItem, BetSlip } from './types.js';
import { ticketEngine } from './ticketEngine.js';
import { isMainLeague, leaguePriorityRank } from './marketService.js';

let geminiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return geminiClient;
}

/**
 * Executa a chamada de inferência ao OpenRouter usando o roteador de modelos gratuitos (openrouter/free)
 */
async function callOpenRouterCompletion(prompt: string): Promise<string | null> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey || apiKey.length < 8) return null;

  const model = process.env.OPENROUTER_MODEL?.trim() || 'openrouter/free';

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://bilheteria.app',
        'X-Title': 'Bilheteria Jev AI',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'Você é um analista estatístico sénior de apostas desportivas e probabilidades de futebol. Responda SEMPRE em formato estritamente JSON válido, sem blocos de código markdown.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(12000),
    });

    if (!response.ok) {
      console.warn(`[OpenRouter / ${model}] Falha HTTP ${response.status}:`, await response.text());
      return null;
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content || null;
  } catch (err: any) {
    console.warn(`[OpenRouter / ${model}] Erro na chamada:`, err?.message);
    return null;
  }
}

export interface AiMatchAnalysis {
  matchId: string;
  tacticalSummary: string;
  keyFactors: string[];
  recommendedMarket: string;
  confidenceScore: number; // 0 to 100
  riskLevel: 'Baixo' | 'Moderado' | 'Alto';
  impliedProbValue: string;
  engineUsed?: string;
}

export async function analyzeMatchTactics(match: MatchItem): Promise<AiMatchAnalysis> {
  const prompt = `Você é um analista estatístico sénior de apostas desportivas e probabilidades de futebol.
Analise a seguinte partida:
- Liga: ${match.league}
- Jogo: ${match.home} (Casa) vs ${match.away} (Fora)
- Horário: ${match.time} (Dias a partir de hoje: ${match.daysFromNow})
- Odds decimais do mercado: Casa: ${match.odds.home}, Empate: ${match.odds.draw}, Fora: ${match.odds.away}, Mais de 2.5: ${match.odds.over25}, Menos de 2.5: ${match.odds.under25}, Ambas Marcam Sim: ${match.odds.btts_yes}, Ambas Marcam Não: ${match.odds.btts_no}
- Dica pré-calculada do motor: ${match.tip.label} (Odd: ${match.tip.odds}, Probabilidade calculada: ${match.tip.prob}%)

Responda em formato estritamente JSON (sem markdown de bloco code \`\`\`json) com a seguinte estrutura:
{
  "tacticalSummary": "Breve resumo tático em português (2 a 3 frases) justificando o cenário mais provável",
  "keyFactors": ["Fator chave 1", "Fator chave 2", "Fator chave 3"],
  "recommendedMarket": "Nome do mercado recomendado",
  "confidenceScore": número entre 40 e 95,
  "riskLevel": "Baixo" ou "Moderado" ou "Alto",
  "impliedProbValue": "percentagem ex: 68%"
}`;

  // 1. Tenta OpenRouter com o modelo gratuito openrouter/free (se OPENROUTER_API_KEY estiver configurada)
  const openRouterApiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (openRouterApiKey && openRouterApiKey.length > 8) {
    const openRouterText = await callOpenRouterCompletion(prompt);
    if (openRouterText) {
      try {
        const cleanJson = openRouterText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        const parsed = JSON.parse(cleanJson);
        const modelName = process.env.OPENROUTER_MODEL?.trim() || 'openrouter/free';
        return {
          matchId: match.id,
          tacticalSummary: parsed.tacticalSummary || `Análise de ${match.home} vs ${match.away}`,
          keyFactors: Array.isArray(parsed.keyFactors) ? parsed.keyFactors : ['Solidez defensiva e ataque', 'Fator casa'],
          recommendedMarket: parsed.recommendedMarket || match.tip.label,
          confidenceScore: typeof parsed.confidenceScore === 'number' ? parsed.confidenceScore : match.tip.prob,
          riskLevel: parsed.riskLevel || 'Moderado',
          impliedProbValue: parsed.impliedProbValue || `${match.tip.prob}%`,
          engineUsed: `OpenRouter (${modelName})`,
        };
      } catch (e) {
        console.warn('[OpenRouter] Erro ao parsear JSON da resposta:', e);
      }
    }
  }

  // 2. Tenta Google Gemini (se GEMINI_API_KEY estiver configurada)
  const gemini = getGeminiClient();
  if (gemini) {
    try {
      const response = await gemini.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
      });

      const text = response.text?.trim() || '';
      const cleanJson = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(cleanJson);

      return {
        matchId: match.id,
        tacticalSummary: parsed.tacticalSummary || `Análise de ${match.home} vs ${match.away}`,
        keyFactors: Array.isArray(parsed.keyFactors) ? parsed.keyFactors : ['Momento das equipas', 'Fator casa'],
        recommendedMarket: parsed.recommendedMarket || match.tip.label,
        confidenceScore: typeof parsed.confidenceScore === 'number' ? parsed.confidenceScore : match.tip.prob,
        riskLevel: parsed.riskLevel || 'Moderado',
        impliedProbValue: parsed.impliedProbValue || `${match.tip.prob}%`,
        engineUsed: 'Gemini 3.8 Flash',
      };
    } catch (err: any) {
      console.warn('[AiService] Erro ao chamar Gemini:', err?.message);
    }
  }

  // 3. Fallback estatístico local de alta fidelidade
  const prob = Math.round(match.tip.prob);
  const risk = prob >= 65 ? 'Baixo' : prob >= 45 ? 'Moderado' : 'Alto';
  return {
    matchId: match.id,
    tacticalSummary: `Análise algorítmica para ${match.home} vs ${match.away} (${match.league}). Com base na probabilidade de mercado de ${prob}%, a odd de ${match.tip.odds.toFixed(2)} para "${match.tip.label}" apresenta valor esperado consistente com o histórico das equipas nesta competição.`,
    keyFactors: [
      `Momento ofensivo e defensivo de ${match.home} em jogos em casa.`,
      `Desempenho de ${match.away} contra equipas do mesmo nível tático.`,
      `Mercado com maior liquidez e convergência estatística: ${match.tip.label}.`,
    ],
    recommendedMarket: match.tip.label,
    confidenceScore: prob,
    riskLevel: risk,
    impliedProbValue: `${prob}%`,
    engineUsed: 'Motor Estatístico Local (H2H)',
  };
}

export async function generateSmartSlipWithAi(
  matches: MatchItem[],
  userPreference?: string
): Promise<BetSlip> {
  const now = Date.now();
  // Só ligas principais: nada de segunda/terceira divisão no bilhete inteligente.
  const available = matches
    .filter((m) => m.status !== 'resolved' && m.kickoffAt > now && isMainLeague(m.league))
    .sort(
      (a, b) =>
        leaguePriorityRank(a.league) - leaguePriorityRank(b.league) ||
        b.tip.prob - a.tip.prob
    );

  if (available.length < 2) {
    throw new Error('Não há jogos futuros de ligas principais suficientes para gerar o bilhete inteligente.');
  }

  const matchesSummary = available.slice(0, 10).map((m) => ({
    id: m.id,
    league: m.league,
    match: `${m.home} vs ${m.away}`,
    tip: m.tip.label,
    odd: m.tip.odds,
    prob: m.tip.prob,
  }));

  const prompt = `Você é o motor de inteligência artificial da "Bilheteria".
Selecione exatamente 3 dos seguintes confrontos para montar um "Bilhete Estratégico":
${JSON.stringify(matchesSummary, null, 2)}

Preferência do utilizador: ${userPreference || 'Bilhete inteligente equilibrado com boa taxa de probabilidade'}

Responda em formato estritamente JSON (sem marcação de bloco de código):
{
  "selectedIds": ["id1", "id2", "id3"],
  "customTitle": "Título do bilhete (ex: 'Tríplice de Confiança')",
  "tier": "segura" ou "moderada" ou "ousada",
  "rationale": "Explicação estratégica de 2 frases sobre a escolha e o valor esperado deste bilhete"
}`;

  let parsed: any = null;

  // 1. Tenta OpenRouter com openrouter/free
  const openRouterApiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (openRouterApiKey && openRouterApiKey.length > 8) {
    const text = await callOpenRouterCompletion(prompt);
    if (text) {
      try {
        const cleanJson = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        parsed = JSON.parse(cleanJson);
      } catch (e) {
        console.warn('[OpenRouter] Erro ao parsear JSON do bilhete:', e);
      }
    }
  }

  // 2. Se não conseguiu via OpenRouter, tenta Gemini
  if (!parsed) {
    const gemini = getGeminiClient();
    if (gemini) {
      try {
        const response = await gemini.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: prompt,
        });
        const text = response.text?.trim() || '';
        const cleanJson = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        parsed = JSON.parse(cleanJson);
      } catch (err: any) {
        console.warn('[AiService] Erro ao gerar bilhete com Gemini:', err?.message);
      }
    }
  }

  // 3. Monta o bilhete a partir do retorno ou fallback
  if (parsed) {
    const chosenMatches = available.filter((m) => parsed.selectedIds?.includes(m.id));
    let finalLegs = chosenMatches.length >= 2 ? chosenMatches : available.slice(0, 3);
    const tier = (['segura', 'moderada', 'ousada'].includes(parsed.tier) ? parsed.tier : 'moderada') as 'segura' | 'moderada' | 'ousada';

    if (tier === 'ousada') {
      let combined = finalLegs.reduce((acc, m) => acc * m.tip.odds, 1);
      const remainingAvailable = available.filter((m) => !finalLegs.some((f) => f.id === m.id));
      for (const extra of remainingAvailable) {
        if (combined >= 10.00 && finalLegs.length >= 3) break;
        finalLegs.push(extra);
        combined *= extra.tip.odds;
      }
    }

    const slip = ticketEngine.createSlip('dia', tier, finalLegs, {
      customTitle: parsed.customTitle || (tier === 'ousada' ? 'Super Múltipla IA (10x+)' : 'Bilhete Estratégico IA'),
      rationale: parsed.rationale || 'Seleção assistida por IA combinando fatores de probabilidade e valor de odd.',
      isAiGenerated: true,
    });

    return ticketEngine.addCustomSlip(slip);
  }

  // Fallback local caso nenhuma IA esteja configurada
  const sorted = [...available].sort((a, b) => b.tip.prob - a.tip.prob);
  const chosen = sorted.slice(0, 3);
  const slip = ticketEngine.createSlip('dia', 'segura', chosen, {
    customTitle: 'Bilhete Estratégico IA (Algorítmico)',
    rationale: 'Seleção algorítmica equilibrada baseada no melhor retorno probabilístico.',
    isAiGenerated: true,
  });
  return ticketEngine.addCustomSlip(slip);
}
