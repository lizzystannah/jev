import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { marketService, MARKET_LABELS, oddsSignature } from './server/marketService.js';
import { ticketEngine } from './server/ticketEngine.js';
import { ticketScheduler } from './server/ticketScheduler.js';
import { bilheteriaDb } from './server/db.js';
import { analyzeMatchTactics, generateSmartSlipWithAi } from './server/aiService.js';
import { aiscoreClient, decodePackedSint32, parseMatchScores, scoutToMatchContext } from './server/aiscoreService.js';
import {
  getLocalCumulativeMetrics,
  AISCORE_ENGINE_VERSION,
  callLocalInferenceEngine,
  evaluateOne,
} from './server/aiscoreEngine.js';
import { resolvePremierBetOdds } from './server/premierbetOdds.js';
import { jevStatus } from './server/jevEngine.js';
import { cacheGet, cacheSet, cacheDel } from './server/cache.js';
import type { BetSlip, MarketType, MatchItem, SlipScope, SlipTier, SlipUpload } from './server/types.js';
import {
  PremierBetConfigError,
  premierBetStatus,
  uploadSlipToPremierBet,
} from './server/premierbet.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);
const isProd = process.env.NODE_ENV === 'production';

async function startServer() {
  // Persistência primeiro: sem base de dados pronta não há fichas nem agendador.
  await bilheteriaDb.init();
  await ticketEngine.init();

  const app = express();
  app.use(express.json());

  /** Anexa à ficha o estado da última submissão à Premier Bet. */
  const withUploads = (slips: BetSlip[]): BetSlip[] =>
    slips.map((slip) => ({ ...slip, upload: bilheteriaDb.getUpload(slip.id) }));

  /** Evita dois cliques simultâneos na mesma ficha (risco de aposta duplicada). */
  const uploadsInFlight = new Set<string>();

  // Background resolver: placar REAL via AiScore (match/data), a cada 90s.
  // Só resolve jogos terminados (statusId 8); jogos iniciados viram 'live'.
  // Bilhetes com 1 perna falhada caem para 'perdeu' na hora (validateSlips).
  let resolving = false;
  setInterval(async () => {
    if (resolving) return;
    resolving = true;
    try {
      const resolved = await marketService.resolveDueMatches(8);
      if (resolved.length > 0) {
        const { updatedSlips } = ticketEngine.validateSlips();
        console.log(`[Bilheteria Engine] ${resolved.length} jogo(s) resolvido(s) com placar real. ${updatedSlips.length} bilhete(s) atualizados.`);
        // Repõe imediatamente o estoque das fichas que caíram (ganhas/perdidas/vencidas).
        void ticketScheduler.tick('resolution');
      } else {
        // Mesmo sem FT novo, propaga 'live' e valida expiração de bilhetes.
        marketService.resolveAllOverdue();
        const { updatedSlips } = ticketEngine.validateSlips();
        if (updatedSlips.length > 0) {
          void ticketScheduler.tick('expiry');
        }
      }
    } catch (err) {
      console.warn('[Bilheteria Engine] Falha no ciclo de resolução real:', (err as Error)?.message);
    } finally {
      resolving = false;
    }
  }, 90_000);

  // ==========================================
  // API ROUTES
  // ==========================================

  // System & Provider Status
  app.get('/api/status', (req: Request, res: Response) => {
    const providerStatus = marketService.getProviderStatus();
    const geminiKey = process.env.GEMINI_API_KEY?.trim();
    const hasGeminiApiKey = Boolean(geminiKey && geminiKey !== 'MY_GEMINI_API_KEY');

    res.json({
      status: 'online',
      serverTime: new Date().toISOString(),
      provider: providerStatus,
      jevEngine: {
        // Mesmo nome de chave por compatibilidade com o frontend;
        // o conteúdo agora é o motor LOCAL (sem Jev/OpenRouter).
        isRemoteKeyConfigured: true,
        provider: 'local',
        modelVersion: AISCORE_ENGINE_VERSION,
        architecture: 'Local AiScore Engine (Poisson + taxas empíricas + H2H)',
        latencyMs: ticketEngine.getLastJevLatency(),
        supportedScopes: ['dia', '2_3_dias', 'longo'],
        strictlyEnforced: false,
        metrics: getLocalCumulativeMetrics(),
      },
      aiEngine: {
        hasGeminiApiKey,
        model: hasGeminiApiKey ? 'gemini-3.8-flash' : AISCORE_ENGINE_VERSION,
        features: ['Análise Tática de Jogos (OpenRouter Free)', 'Gerador de Bilhetes Estratégicos com IA'],
      },
      stats: {
        totalMatches: providerStatus.totalMatches,
        totalSlips: ticketEngine.getSlips().length,
      },
      tickets: ticketScheduler.getStatus(),
    });
  });

  // Mercados suportados no seletor de tips (mesmos do motor).
  const ALL_MARKETS: MarketType[] = [
    'home', 'draw', 'away',
    'double_chance_1x', 'double_chance_x2', 'double_chance_12',
    'over15', 'over25', 'over35', 'under25', 'under35',
    'btts_yes', 'btts_no', 'dnb_home', 'dnb_away',
  ];

  // Matches list com TODAS as tips calculadas (probabilidade por mercado).
  // O motor é local e determinístico, por isso roda sobre a lista inteira.
  app.get('/api/matches', async (req: Request, res: Response) => {
    try {
      const forceRefresh = req.query.refresh === 'true';
      const cacheKey = 'matches:api:v2';
      if (!forceRefresh) {
        const cached = await cacheGet(cacheKey);
        if (cached) return res.type('application/json').send(cached);
      }
      const matches = await marketService.getMatches(forceRefresh);
      let enriched = matches;
      try {
        // Calibração persistida: reutiliza as tips se a assinatura de odds não
        // mudou. Só recalcula o que é novo ou cujas odds mudaram (nem rede nem
        // CPU a cada redeploy). Sem odds e sem scout não se inventa prob.
        const needsCalibration = (m: MatchItem): boolean =>
          (!m.calibration || m.calibration.oddsHash !== oddsSignature(m.odds)) &&
          ((m.odds.realMarkets?.length || 0) > 0 || Boolean(m.scout));
        const evalPool = matches.filter(needsCalibration);

        if (evalPool.length > 0) {
          const local = await callLocalInferenceEngine({
            scope: 'dia',
            horizonDays: 8,
            matches: evalPool.map((m) => ({
              id: m.id,
              league: m.league,
              home: m.home,
              away: m.away,
              daysFromNow: m.daysFromNow,
              odds: m.odds,
              context: m.context,
              scout: m.scout,
              advanced: m.advanced,
              tables: m.tables,
              lineups: m.lineups,
            })),
          });
          const byId = new Map(local.evaluations.map((e) => [e.matchId, e]));
          for (const m of matches) {
            const ev = byId.get(m.id);
            if (!ev) continue;
            const chosen = ev.tips.find((t) => t.market === ev.recommendedMarket);
            m.calibration = {
              tips: ev.tips,
              recommendedMarket: ev.recommendedMarket,
              marketLabel: ev.marketLabel,
              calibratedProb: ev.calibratedProb,
              expectedValueEdge: ev.expectedValueEdge,
              highRiskTip: ev.highRiskTip,
              oddsHash: oddsSignature(m.odds),
              at: Date.now(),
            };
            m.tips = ev.tips;
            m.tip = {
              market: ev.recommendedMarket,
              label: ev.marketLabel,
              odds: chosen?.odds ?? ev.selectedOdds,
              prob: ev.calibratedProb,
            };
          }
          marketService.saveCacheSoon();
        }

        // Aplica a calibração persistida a todos os jogos que a tenham.
        enriched = matches.map((m) => {
          if (!m.calibration) return m;
          const chosen = m.calibration.tips.find(
            (t) => t.market === m.calibration!.recommendedMarket
          );
          return {
            ...m,
            tips: m.calibration.tips,
            tip: {
              market: m.calibration.recommendedMarket,
              label: m.calibration.marketLabel,
              odds: chosen?.odds ?? 0,
              prob: m.calibration.calibratedProb,
            },
          };
        });
      } catch (err: any) {
        console.warn('[Tips] falha ao calcular tips da lista:', err?.message);
      }
      const body = JSON.stringify(enriched);
      await cacheSet(cacheKey, body, 25_000);
      res.type('application/json').send(body);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao carregar jogos' });
    }
  });

  // Lista de mercados para o seletor de tips.
  app.get('/api/tips/markets', (_req: Request, res: Response) => {
    res.json(
      ALL_MARKETS.map((market) => ({
        market,
        label: MARKET_LABELS[market]
          ? MARKET_LABELS[market]({ home: 'Casa', away: 'Fora' })
          : market,
      }))
    );
  });

  // Sincronização explícita e protegida com The Odds API (disparada intencionalmente pelo usuário)
  app.post('/api/market/sync-odds', async (req: Request, res: Response) => {
    try {
      const matches = await marketService.getMatches(true);
      const status = marketService.getProviderStatus();
      await cacheDel('matches:api:v2');
      res.json({
        success: true,
        message: 'Sincronização processada com sucesso.',
        status,
        matchesCount: matches.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao sincronizar com The Odds API' });
    }
  });

  // Resolve manual — SOMENTE dev (ALLOW_SIMULATION=true). Em produção, a
  // resolução é automática com placar real do AiScore (resolveDueMatches).
  app.post('/api/matches/resolve', async (req: Request, res: Response) => {
    try {
      if (process.env.ALLOW_SIMULATION !== 'true') {
        return res.status(403).json({ error: 'Resolução manual desativada em produção. Bilhetes resolvem automaticamente com o placar real.' });
      }
      const { matchId, resolveNextPending } = req.body;
      const allMatches = await marketService.getMatches();

      if (matchId) {
        const resolved = marketService.resolveMatch(matchId);
        ticketEngine.validateSlips();
        return res.json({ resolved: [resolved], allSlips: ticketEngine.getSlips() });
      }

      if (resolveNextPending) {
        const pending = allMatches.find((m) => m.status !== 'resolved');
        if (pending) {
          const resolved = marketService.resolveMatch(pending.id);
          ticketEngine.validateSlips();
          return res.json({ resolved: [resolved], allSlips: ticketEngine.getSlips() });
        }
      }

      res.json({ resolved: [], allSlips: ticketEngine.getSlips() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao resolver partida' });
    }
  });

  // Reset matches & regenerate
  app.post('/api/matches/reset', async (req: Request, res: Response) => {
    try {
      if (uploadsInFlight.size > 0) {
        return res.status(409).json({
          error:
            'Há uma submissão à Premier Bet em curso. Aguarde o resultado antes de reiniciar as fichas.',
        });
      }
      const matches = marketService.resetMatches();
      ticketEngine.clearSlips();
      await ticketScheduler.forceRefillAll();
      res.json({ matches, slips: withUploads(ticketEngine.getSlips()) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao reiniciar partidas' });
    }
  });

  // Slips list (filtro opcional por motor: local|manual|jev)
  app.get('/api/tickets', (req: Request, res: Response) => {
    // Run validation sweep before returning
    ticketEngine.validateSlips();
    const engine = String(req.query.engine || '').trim();
    const slips = ['local', 'manual', 'jev'].includes(engine)
      ? ticketEngine.getSlips().filter((s) => (s.engine ?? 'local') === engine)
      : ticketEngine.getSlips();
    res.json(withUploads(slips));
  });

  // Stock/quota status (usado pelo frontend e por monitorização)
  app.get('/api/tickets/stock', (req: Request, res: Response) => {
    res.json(ticketScheduler.getStatus());
  });

  // Generate slips for scope (botão manual em qualquer parte do site)
  app.post('/api/tickets/generate', async (req: Request, res: Response) => {
    try {
      const { scope = 'dia', leagues, limit, market } = req.body || {};
      const validScopes = ['dia', '2_3_dias', 'longo'];
      if (!validScopes.includes(scope)) {
        return res.status(400).json({ error: `Escopo inválido: ${scope}` });
      }
      if (market !== undefined && market !== null && market !== '' && !ALL_MARKETS.includes(market)) {
        return res.status(400).json({ error: `Tipo de tip inválido: ${market}` });
      }
      const result = await ticketScheduler.generateMore(
        scope,
        Array.isArray(leagues) ? leagues : undefined,
        Number(limit) > 0 ? Number(limit) : 4,
        market || undefined,
        'local'
      );
      await cacheDel('matches:api:v2');
      res.json({
        ...result,
        all: withUploads(result.all),
        generated: withUploads(result.generated),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao gerar bilhetes' });
    }
  });

  // ------------------------------------------------------------------- JEV ---

  // Estado do JEV (configuração/modelo; nunca expõe a chave).
  app.get('/api/jev/status', (_req: Request, res: Response) => {
    res.json(jevStatus());
  });

  // Gera fichas com o JEV a decidir a tip de cada jogo (probabilidades
  // continuam a ser as do motor local).
  app.post('/api/jev/generate', async (req: Request, res: Response) => {
    try {
      const status = jevStatus();
      if (!status.configured) {
        return res.status(503).json({
          error:
            'JEV não configurado. Defina JEV_API_KEY (ou OPENROUTER_API_KEY), JEV_MODEL e JEV_API_URL na env.',
        });
      }
      const { scope = 'dia', leagues, limit } = req.body || {};
      const validScopes = ['dia', '2_3_dias', 'longo'];
      if (!validScopes.includes(scope)) {
        return res.status(400).json({ error: `Escopo inválido: ${scope}` });
      }
      const result = await ticketScheduler.generateMore(
        scope,
        Array.isArray(leagues) ? leagues : undefined,
        Number(limit) > 0 ? Number(limit) : 4,
        undefined,
        'jev'
      );
      await cacheDel('matches:api:v2');
      res.json({
        ...result,
        all: withUploads(result.all),
        generated: withUploads(result.generated),
      });
    } catch (err: any) {
      res.status(502).json({ error: err?.message || 'Erro ao gerar fichas com JEV' });
    }
  });

  // Ficha manual: legs explícitas escolhidas na lista de tips.
  app.post('/api/tickets/custom', async (req: Request, res: Response) => {
    try {
      const { scope = 'dia', tier = 'moderada', legs } = req.body || {};
      const validScopes = ['dia', '2_3_dias', 'longo'];
      const validTiers = ['segura', 'moderada', 'ousada', 'maluca'];
      if (!validScopes.includes(scope)) {
        return res.status(400).json({ error: `Escopo inválido: ${scope}` });
      }
      if (!validTiers.includes(tier)) {
        return res.status(400).json({ error: `Tier inválido: ${tier}` });
      }
      if (!Array.isArray(legs) || legs.length === 0) {
        return res.status(400).json({ error: 'Escolha pelo menos um jogo/tip.' });
      }
      const selections = legs.map((l: any) => ({
        matchId: String(l?.matchId || ''),
        market: String(l?.market || '') as MarketType,
      }));
      const invalid = selections.find(
        (s) => !s.matchId || !ALL_MARKETS.includes(s.market)
      );
      if (invalid) {
        return res.status(400).json({ error: `Seleção inválida: ${invalid.market || '?'}` });
      }
      if (new Set(selections.map((s) => s.matchId)).size !== selections.length) {
        return res.status(400).json({ error: 'O mesmo jogo não pode entrar duas vezes na ficha.' });
      }
      const now = Date.now();
      const matches = await marketService.getMatches(false);
      const byId = new Map(matches.map((m) => [m.id, m]));

      // Odds reais em falta: consulta a Premier Bet (só API) para os mercados
      // que o feed do AiScore não cobre (DC, over/under 1.5/3.5, DNB).
      const needPb = selections
        .map((sel, index) => ({ sel, index, match: byId.get(sel.matchId) }))
        .filter(
          (x) => x.match && !x.match.odds.realMarkets?.includes(x.sel.market)
        );
      const pbOddsByIndex = new Map<number, number>();
      if (needPb.length > 0) {
        try {
          const pb = await resolvePremierBetOdds(
            needPb.map((x) => ({
              home: x.match!.home,
              away: x.match!.away,
              kickoffAt: x.match!.kickoffAt,
              date: x.match!.dateStr,
              markets: [x.sel.market],
            }))
          );
          needPb.forEach((x, i) => {
            const result =
              pb.results[i] ??
              pb.results.find(
                (r) =>
                  r.home.trim().toLowerCase() === x.match!.home.trim().toLowerCase() &&
                  r.away.trim().toLowerCase() === x.match!.away.trim().toLowerCase()
              );
            const odd = result?.odds?.[x.sel.market];
            if (typeof odd === 'number' && Number.isFinite(odd) && odd > 1.01) {
              pbOddsByIndex.set(x.index, Number(odd.toFixed(2)));
            }
          });
        } catch (err: any) {
          console.warn('[PremierBet] falha a obter odds da ficha manual:', err?.message);
        }
      }

      const built: MatchItem[] = [];
      const errors: string[] = [];
      selections.forEach((sel, index) => {
        const match = byId.get(sel.matchId);
        if (!match) {
          errors.push(`jogo não encontrado (${sel.matchId})`);
          return;
        }
        if (match.kickoffAt <= now) {
          errors.push(`${match.home} v ${match.away}: jogo já começou`);
          return;
        }
        let odds = match.odds;
        if (!odds.realMarkets?.includes(sel.market)) {
          const pbOdd = pbOddsByIndex.get(index);
          if (pbOdd) {
            odds = {
              ...odds,
              [sel.market]: pbOdd,
              realMarkets: Array.from(new Set([...(odds.realMarkets || []), sel.market])),
            } as MatchItem['odds'];
          }
        }
        const ev = evaluateOne({
          id: match.id,
          league: match.league,
          home: match.home,
          away: match.away,
          daysFromNow: match.daysFromNow,
          odds,
          context: match.context,
          scout: match.scout,
          advanced: match.advanced,
          tables: match.tables,
          lineups: match.lineups,
          forcedMarket: sel.market,
        });
        if (!ev || ev.selectedOdds <= 1.01) {
          errors.push(
            `${match.home} v ${match.away}: sem odd real para "${MARKET_LABELS[sel.market]?.({ home: match.home, away: match.away }) || sel.market}"`
          );
          return;
        }
        built.push({
          ...match,
          odds,
          tips: ev.tips,
          tip: {
            market: ev.recommendedMarket,
            label: ev.marketLabel,
            odds: ev.selectedOdds,
            prob: ev.calibratedProb,
          },
          highRiskTip: ev.highRiskTip,
        });
      });

      if (built.length !== selections.length) {
        return res.status(409).json({
          error: errors.join('; ') || 'Não foi possível precificar todas as seleções.',
        });
      }

      const slip = ticketEngine.createSlip(scope as SlipScope, tier as SlipTier, built, {
        customTitle: `Ficha manual (${built.length} jogos)`,
        rationale:
          'Ficha montada manualmente a partir das tips calculadas pelo motor; todas as odds são reais.',
        isAiGenerated: false,
        engine: 'manual',
      });
      const added = ticketEngine.addCustomSlip(slip);
      await cacheDel('matches:api:v2');
      res.json({
        slip: { ...added, upload: bilheteriaDb.getUpload(added.id) },
        all: withUploads(ticketEngine.getSlips()),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao criar ficha manual' });
    }
  });

  // ---------------------------------------------------------------- premier bet ---

  // Configuração visível ao frontend (sem expor credenciais).
  app.get('/api/premierbet/status', (req: Request, res: Response) => {
    res.json(premierBetStatus());
  });

  // Sobe uma ficha para a Premier Bet: login, boletim e (se não for dry-run)
  // colocação da aposta com o valor indicado em Kwanzas.
  app.post('/api/tickets/:id/upload', async (req: Request, res: Response) => {
    const slip = ticketEngine.getSlips().find((s) => s.id === req.params.id);
    if (!slip) {
      return res.status(404).json({ error: 'Ficha não encontrada.' });
    }
    if (slip.status !== 'pendente') {
      return res.status(409).json({
        error: 'Só é possível subir fichas pendentes (ainda não resolvidas ou expiradas).',
      });
    }
    if (uploadsInFlight.has(slip.id)) {
      return res.status(409).json({
        error: 'Esta ficha já está a ser subida para a Premier Bet. Aguarde o resultado.',
      });
    }

    const stake = Number(req.body?.stake);
    const status = premierBetStatus();
    if (!Number.isFinite(stake) || stake <= 0) {
      return res.status(400).json({ error: 'Indique um valor de aposta válido (em Kwanzas).' });
    }
    if (stake < status.minStake) {
      return res.status(400).json({ error: `O valor mínimo é ${status.minStake} Kz.` });
    }
    if (status.maxStake > 0 && stake > status.maxStake) {
      return res.status(400).json({
        error: `O valor máximo configurado é ${status.maxStake} Kz.`,
      });
    }

    const dryRun = Boolean(req.body?.dryRun) || status.dryRun;
    const force = req.body?.force === true;
    const existing = bilheteriaDb.getUpload(slip.id);

    if (!dryRun && existing?.status === 'placed' && !force) {
      return res.status(409).json({
        error: `Esta ficha já foi colocada na Premier Bet${
          existing.betId ? ` (ID ${existing.betId})` : ''
        }. Confirme para subir novamente.`,
        upload: existing,
      });
    }
    if (!dryRun && existing?.status === 'unknown' && !force) {
      return res.status(409).json({
        error:
          'A tentativa anterior ficou por confirmar. Verifique as apostas abertas na Premier Bet antes de tentar novamente.',
        upload: existing,
      });
    }
    if (!dryRun && existing?.status === 'in_progress' && !force) {
      return res.status(409).json({
        error:
          'Esta ficha está a ser subida para a Premier Bet. Aguarde o resultado ou verifique as apostas abertas antes de tentar novamente.',
        upload: existing,
      });
    }
    if (!dryRun && !status.configured) {
      return res.status(503).json({
        error:
          'Credenciais da Premier Bet não configuradas no servidor (PREMIERBET_LOGIN / PREMIERBET_PASSWORD).',
      });
    }
    if (!status.scriptExists) {
      return res.status(503).json({
        error: 'Bridge da Premier Bet não encontrado no servidor (Scraping/premierbet_book.py).',
      });
    }

    uploadsInFlight.add(slip.id);
    let completedUpload: SlipUpload | null = null;
    try {
      // Registo de "em curso" ANTES de clicar em qualquer coisa: se o servidor
      // morrer a meio, o arranque seguinte marca a ficha como "por confirmar"
      // em vez de deixar margem para uma segunda aposta automática.
      if (!dryRun) {
        bilheteriaDb.saveUpload({
          slipId: slip.id,
          status: 'in_progress',
          stake,
          message: 'Submissão em curso na Premier Bet...',
          at: Date.now(),
        });
        try {
          await bilheteriaDb.flush();
        } catch {
          /* a submissão continua; o resultado final volta a ser gravado */
        }
      }

      const result = await uploadSlipToPremierBet({ slip, stake, dryRun });

      // Ficha parcial: algumas pernas não foram localizadas na Premier Bet e
      // a aposta seguiu com as disponíveis. Sincroniza a ficha local com o
      // que foi realmente apostado (remove ausentes, recalcula odd/prob).
      if (result.ok && result.partial) {
        const norm = (s?: string) => (s || '').trim().toLowerCase();
        const okKeys = new Set(
          (result.resolved?.report || [])
            .filter((r) => r.status === 'ok')
            .map((r) => `${norm(r.home)}|${norm(r.away)}|${r.market}`)
        );
        const before = slip.legs.length;
        const kept = slip.legs.filter((leg) =>
          okKeys.has(`${norm(leg.home)}|${norm(leg.away)}|${leg.tip?.market}`)
        );
        if (kept.length > 0 && kept.length < before) {
          slip.legs = kept;
          slip.combinedOdds = Number(
            kept.reduce((acc, l) => acc * (Number(l.tip?.odds) || 1), 1).toFixed(2)
          );
          slip.combinedProb = Number(
            (
              kept.reduce((acc, l) => acc * ((Number(l.tip?.prob) || 0) / 100), 1) *
              100
            ).toFixed(1)
          );
          slip.expiresAt = Math.min(...kept.map((l) => l.kickoffAt));
          bilheteriaDb.upsertSlip(slip);
          console.log(
            `[PremierBet] Ficha ${slip.id}: ${before - kept.length} perna(s) não localizada(s) removida(s); ficha sincronizada com ${kept.length} jogo(s).`
          );
        }
      }

      const uploadStatus: SlipUpload['status'] = result.ok
        ? result.dryRun
          ? 'dry_run'
          : 'placed'
        : result.unknown
          ? 'unknown'
          : 'failed';
      const record: SlipUpload = {
        slipId: slip.id,
        status: uploadStatus,
        stake: result.stake || stake,
        betId: result.betId ?? undefined,
        message: result.message,
        at: Date.now(),
      };
      bilheteriaDb.saveUpload(record);
      completedUpload = record;
      console.log(
        `[PremierBet] Ficha ${slip.id}: ${uploadStatus} (${result.durationMs ?? 0} ms).`
      );
      return res.json({ ...result, upload: record });
    } catch (err: any) {
      if (completedUpload) {
        // A colocação já ficou registada; um erro ao responder ao cliente não
        // pode transformar uma aposta colocada em "falhou" (permitiria duplicar).
        console.warn(
          `[PremierBet] Ficha ${slip.id}: resultado já registado (${completedUpload.status}); falha ao responder: ${err?.message}`
        );
        return;
      }
      const message = err?.message || 'Falha ao subir a ficha para a Premier Bet.';
      const record: SlipUpload = {
        slipId: slip.id,
        status: 'failed',
        stake,
        message,
        at: Date.now(),
      };
      bilheteriaDb.saveUpload(record);
      console.warn(`[PremierBet] Ficha ${slip.id}: falha — ${message}`);
      return res
        .status(err instanceof PremierBetConfigError ? 503 : 502)
        .json({ error: message, upload: record });
    } finally {
      uploadsInFlight.delete(slip.id);
    }
  });

  // AI Tactical Analysis for a single match
  app.post('/api/ai/analyze-match', async (req: Request, res: Response) => {
    try {
      const { matchId } = req.body;
      const matches = await marketService.getMatches();
      const match = matches.find((m) => m.id === matchId);

      if (!match) {
        return res.status(404).json({ error: 'Partida não encontrada' });
      }

      const analysis = await analyzeMatchTactics(match);
      res.json(analysis);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao analisar partida com IA' });
    }
  });

  // AI Smart Slip Builder
  app.post('/api/ai/generate-smart-slip', async (req: Request, res: Response) => {
    try {
      const { preference } = req.body;
      const matches = await marketService.getMatches();
      const slip = await generateSmartSlipWithAi(matches, preference);
      res.json({ slip, allSlips: ticketEngine.getSlips() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao gerar bilhete com IA' });
    }
  });

  // ==========================================
  // AISCORE API ENDPOINTS (JSON via Python bridge / curl_cffi)
  // ==========================================
  app.get('/api/aiscore/status', async (req: Request, res: Response) => {
    try {
      res.json(await aiscoreClient.status());
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro no status AiScore' });
    }
  });

  app.get('/api/aiscore/matches', async (req: Request, res: Response) => {
    try {
      const dateStr =
        (req.query.date as string) || new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const matches = await aiscoreClient.getMatchesForDate(dateStr, {
        upcoming: req.query.upcoming === 'true',
        limit: Number(req.query.limit) || 0,
      });
      res.json({ ok: true, count: matches.length, data: matches });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao consultar AiScore matches' });
    }
  });

  app.get('/api/aiscore/match/:id', async (req: Request, res: Response) => {
    try {
      const scout = await aiscoreClient.getMatchData(req.params.id);
      res.json({ ok: true, data: scout });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao consultar AiScore match data' });
    }
  });

  app.get('/api/aiscore/history/:id', async (req: Request, res: Response) => {
    try {
      const history = await aiscoreClient.getMatchHistory(req.params.id);
      res.json({ ok: true, data: history });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao consultar AiScore match history' });
    }
  });

  app.get('/api/aiscore/scout/:id', async (req: Request, res: Response) => {
    try {
      const scout = await aiscoreClient.getScout(req.params.id);
      res.json({ ok: true, data: scout });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao consultar AiScore scout' });
    }
  });

  // Placar REAL (FT/HT + status) — fonte da verdade para expiração de bilhetes
  app.get('/api/aiscore/live/:id', async (req: Request, res: Response) => {
    try {
      if (!/^[A-Za-z0-9_-]{4,64}$/.test(req.params.id)) {
        return res.status(400).json({ error: 'match id inválido' });
      }
      const live = await aiscoreClient.getLiveResult(req.params.id);
      if (!live) return res.status(404).json({ error: 'Sem placar real disponível' });
      res.json({ ok: true, data: live });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao consultar placar real' });
    }
  });

  // Força um ciclo de resolução real sob demanda (placar AiScore + validação).
  // Rate-limit 60s: cada ciclo consome throttle do bridge (~1.7s por jogo).
  let lastResolveDueAt = 0;
  app.post('/api/matches/resolve-due', async (req: Request, res: Response) => {
    try {
      if (Date.now() - lastResolveDueAt < 60_000) {
        return res.status(429).json({ error: 'Aguarde 60s entre ciclos de resolução.' });
      }
      lastResolveDueAt = Date.now();
      const resolved = await marketService.resolveDueMatches(8);
      const { updatedSlips } = ticketEngine.validateSlips();
      res.json({ resolved, updatedSlips, allSlips: ticketEngine.getSlips() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao resolver com placar real' });
    }
  });

  // MatchContext pronto para o motor (H2H/forma/importância/descanso)
  app.get('/api/aiscore/context', async (req: Request, res: Response) => {
    try {
      const { home, away, date } = req.query as Record<string, string>;
      if (!home || !away || !date) {
        return res.status(400).json({ error: 'Parâmetros obrigatórios: home, away, date' });
      }
      const meta = await aiscoreClient.resolveMatchId(home, away, date);
      if (!meta?.match_id) {
        return res.status(404).json({ error: 'Partida não encontrada no AiScore' });
      }
      const scout = await aiscoreClient.getScout(meta.match_id);
      const kickoffMs = meta.kickoff ? Date.parse(meta.kickoff.replace(' ', 'T') + '-03:00') : undefined;
      res.json({
        ok: true,
        aiscoreMatchId: meta.match_id,
        data: scoutToMatchContext(scout, Number.isFinite(kickoffMs) ? kickoffMs : undefined),
        scout,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao obter contexto AiScore' });
    }
  });

  // ==========================================
  // VITE / STATIC SERVING
  // ==========================================
  if (!isProd) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Bilheteria Backend] Servidor ativo em http://0.0.0.0:${PORT}`);

    // Agendador em background: fichas do dia à meia-noite (Angola), reposição de
    // estoque, expiração e sincronização de mercado — funciona sem browser aberto.
    ticketScheduler.start();

    // Quando o backfill dos dias +1..+8 termina, repõe as quotas dos escopos
    // futuros (2-3 dias / longo) sem esperar o próximo tick.
    marketService.onAiscoreBackfillDone(() => {
      void ticketScheduler.tick('aiscore-backfill');
    });
  });

  const shutdown = async (signal: string) => {
    console.log(`[Bilheteria Backend] ${signal} recebido. A encerrar agendador e a gravar estado...`);
    ticketScheduler.stop();
    try {
      await bilheteriaDb.close();
    } catch (err: any) {
      console.warn('[Bilheteria Backend] Falha ao fechar base de dados:', err?.message);
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('[Bilheteria Backend] Falha fatal ao iniciar servidor:', err);
});
