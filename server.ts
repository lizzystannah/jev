import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { marketService, labelForMarket, oddsSignature } from './server/marketService.js';
import { COMPOSTA_MARKETS, isCompostaMarket } from './server/compostas.js';
import { ticketEngine } from './server/ticketEngine.js';
import { ticketScheduler } from './server/ticketScheduler.js';
import { progressionEngine } from './server/progressionEngine.js';
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
import { matchesApiCacheKey } from './server/cacheKeys.js';
import type { BetSlip, MarketType, MatchItem, SlipEngine, SlipScope, SlipTier, SlipUpload } from './server/types.js';
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
  // PersistÃªncia primeiro: sem base de dados pronta nÃ£o hÃ¡ fichas nem agendador.
  await bilheteriaDb.init();
  await ticketEngine.init();
  await progressionEngine.init();

  const app = express();
  app.use(express.json());

  /** Anexa Ã  ficha o estado da Ãºltima submissÃ£o Ã  Premier Bet. */
  const withUploads = (slips: BetSlip[]): BetSlip[] =>
    slips.map((slip) => ({ ...slip, upload: bilheteriaDb.getUpload(slip.id) }));

  /** Evita dois cliques simultÃ¢neos na mesma ficha (risco de aposta duplicada). */
  const uploadsInFlight = new Set<string>();

  // ========================== validaÃ§Ã£o de resultados ==========================
  //
  // 1) VARREDURA EM MASSA a cada RESULTS_SWEEP_MINUTES (default 15): UMA Ãºnica
  //    chamada matches?date= traz statusId + placares de todos os jogos do dia.
  //    SÃ³ jogos terminados sÃ£o aplicados. Inclui ontem (jogos que acabam apÃ³s
  //    a meia-noite).
  // 2) A cada minuto, um passe prioritÃ¡rio resolve as pernas das FICHAS
  //    pendentes via match/data, sem esperar a varredura.
  const RESULT_SWEEP_MS =
    Math.max(1, Number(process.env.RESULTS_SWEEP_MINUTES || 15)) * 60_000;
  let lastResultSweepAt = 0;
  let resolving = false;

  const pendingSlipLegIds = (): Set<string> =>
    new Set(
      ticketEngine
        .getSlips()
        .filter((s) => s.status === 'pendente')
        .flatMap((s) => s.legs.map((l) => l.id))
    );

  const runResultsCycle = async (): Promise<void> => {
    if (resolving) return;
    resolving = true;
    try {
      const allowIds = pendingSlipLegIds();
      if (Date.now() - lastResultSweepAt >= RESULT_SWEEP_MS) {
        lastResultSweepAt = Date.now();
        await marketService.resolveFromDayResults({ offsets: [0, -1, -2], allowIds });
      }
      const resolved = await marketService.resolveDueMatches(12, allowIds);
      if (resolved.length > 0) {
        const { updatedSlips } = ticketEngine.validateSlips();
        console.log(
          `[Bilheteria Engine] ${resolved.length} jogo(s) resolvido(s) com placar real. ` +
            `${updatedSlips.length} bilhete(s) atualizados.`
        );
        // RepÃµe imediatamente o estoque das fichas que caÃ­ram.
        void ticketScheduler.tick('resolution');
      } else {
        // Mesmo sem FT novo, propaga 'live' e valida expiraÃ§Ã£o de bilhetes.
        marketService.resolveAllOverdue();
        const { updatedSlips } = ticketEngine.validateSlips();
        if (updatedSlips.length > 0) {
          void ticketScheduler.tick('expiry');
        }
      }
    } catch (err) {
      console.warn(
        '[Bilheteria Engine] Falha no ciclo de resoluÃ§Ã£o real:',
        (err as Error)?.message
      );
    } finally {
      resolving = false;
    }
  };

  void runResultsCycle();
  setInterval(() => void runResultsCycle(), 60_000);

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
        // o conteÃºdo agora Ã© o motor LOCAL (sem Jev/OpenRouter).
        isRemoteKeyConfigured: true,
        provider: 'local',
        modelVersion: AISCORE_ENGINE_VERSION,
        architecture: 'Local AiScore Engine (Poisson + taxas empÃ­ricas + H2H)',
        latencyMs: ticketEngine.getLastJevLatency(),
        supportedScopes: ['dia', '2_3_dias', 'longo'],
        strictlyEnforced: false,
        metrics: getLocalCumulativeMetrics(),
      },
      aiEngine: {
        hasGeminiApiKey,
        model: hasGeminiApiKey ? 'gemini-3.8-flash' : AISCORE_ENGINE_VERSION,
        features: ['AnÃ¡lise TÃ¡tica de Jogos (OpenRouter Free)', 'Gerador de Bilhetes EstratÃ©gicos com IA'],
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
    ...COMPOSTA_MARKETS,
  ];

  // Matches list com TODAS as tips calculadas (probabilidade por mercado).
  // O motor Ã© local e determinÃ­stico, por isso roda sobre a lista inteira.
  app.get('/api/matches', async (req: Request, res: Response) => {
    try {
      const forceRefresh = req.query.refresh === 'true';
      const cacheKey = matchesApiCacheKey();
      if (!forceRefresh) {
        const cached = await cacheGet(cacheKey);
        if (cached) return res.type('application/json').send(cached);
      }
      const matches = await marketService.getMatches(forceRefresh);
      let enriched = matches;
      try {
        // CalibraÃ§Ã£o persistida: reutiliza as tips se a assinatura de odds nÃ£o
        // mudou. SÃ³ recalcula o que Ã© novo ou cujas odds mudaram (nem rede nem
        // CPU a cada redeploy). Sem odds e sem scout nÃ£o se inventa prob.
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

        // Aplica a calibraÃ§Ã£o persistida a todos os jogos que a tenham.
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
        label: labelForMarket(market, { home: 'Casa', away: 'Fora' }),
      }))
    );
  });

  // SincronizaÃ§Ã£o explÃ­cita e protegida com The Odds API (disparada intencionalmente pelo usuÃ¡rio)
  app.post('/api/market/sync-odds', async (req: Request, res: Response) => {
    try {
      const matches = await marketService.getMatches(true);
      const status = marketService.getProviderStatus();
      await cacheDel(matchesApiCacheKey());
      res.json({
        success: true,
        message: 'SincronizaÃ§Ã£o processada com sucesso.',
        status,
        matchesCount: matches.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao sincronizar com The Odds API' });
    }
  });

  // Resolve manual â€” SOMENTE dev (ALLOW_SIMULATION=true). Em produÃ§Ã£o, a
  // resoluÃ§Ã£o Ã© automÃ¡tica com placar real do AiScore (resolveDueMatches).
  app.post('/api/matches/resolve', async (req: Request, res: Response) => {
    try {
      if (process.env.ALLOW_SIMULATION !== 'true') {
        return res.status(403).json({ error: 'ResoluÃ§Ã£o manual desativada em produÃ§Ã£o. Bilhetes resolvem automaticamente com o placar real.' });
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
            'HÃ¡ uma submissÃ£o Ã  Premier Bet em curso. Aguarde o resultado antes de reiniciar as fichas.',
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
    const slips = ['local', 'manual', 'jev', 'progression'].includes(engine)
      ? ticketEngine.getSlips().filter((s) => (s.engine ?? 'local') === engine)
      : ticketEngine.getSlips();
    res.json(withUploads(slips));
  });

  // Stock/quota status (usado pelo frontend e por monitorizaÃ§Ã£o)
  app.get('/api/tickets/stock', (req: Request, res: Response) => {
    res.json(ticketScheduler.getStatus());
  });

  // Excluir ficha (memÃ³ria + base de dados + registo de submissÃ£o).
  app.delete('/api/tickets/:id', async (req: Request, res: Response) => {
    const slip = ticketEngine.getSlips().find((s) => s.id === req.params.id);
    if (!slip) {
      return res.status(404).json({ error: 'Ficha nÃ£o encontrada.' });
    }
    if (uploadsInFlight.has(slip.id)) {
      return res.status(409).json({
        error:
          'Esta ficha estÃ¡ a ser subida para a Premier Bet. Aguarde o resultado antes de excluir.',
      });
    }
    const deleted = ticketEngine.deleteSlip(slip.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Ficha nÃ£o encontrada.' });
    }
    // Garante que o DELETE chega Ã  BD antes de responder (sem resquÃ­cios).
    try {
      await bilheteriaDb.flush();
    } catch {
      /* a escrita Ã© write-behind; o erro fica no log da BD */
    }
    await cacheDel(matchesApiCacheKey());
    res.json({
      deleted: true,
      id: slip.id,
      all: withUploads(ticketEngine.getSlips()),
      stock: ticketScheduler.getStatus(),
    });
  });

  // Generate slips for scope (botÃ£o manual em qualquer parte do site)
  app.post('/api/tickets/generate', async (req: Request, res: Response) => {
    try {
      const { scope = 'dia', leagues, limit, market, engine = 'local', minOdds } = req.body || {};
      const validScopes = ['dia', '2_3_dias', 'longo'];
      if (!validScopes.includes(scope)) {
        return res.status(400).json({ error: `Escopo invÃ¡lido: ${scope}` });
      }
      if (market !== undefined && market !== null && market !== '' && !ALL_MARKETS.includes(market)) {
        return res.status(400).json({ error: `Tipo de tip invÃ¡lido: ${market}` });
      }
      if (!['local', 'manual'].includes(engine)) {
        return res.status(400).json({ error: `Motor invÃ¡lido: ${engine}` });
      }
      const minOddsValue = Number(minOdds);
      const parsedMinOdds =
        Number.isFinite(minOddsValue) && minOddsValue > 1 ? minOddsValue : undefined;
      const result = await ticketScheduler.generateMore(
        scope,
        Array.isArray(leagues) ? leagues : undefined,
        Number(limit) > 0 ? Number(limit) : 4,
        market || undefined,
        engine as SlipEngine,
        parsedMinOdds
      );
      await cacheDel(matchesApiCacheKey());
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

  // Estado do JEV (configuraÃ§Ã£o/modelo; nunca expÃµe a chave).
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
            'JEV nÃ£o configurado. Defina JEV_API_KEY (ou OPENROUTER_API_KEY), JEV_MODEL e JEV_API_URL na env.',
        });
      }
      const { scope = 'dia', leagues, limit } = req.body || {};
      const validScopes = ['dia', '2_3_dias', 'longo'];
      if (!validScopes.includes(scope)) {
        return res.status(400).json({ error: `Escopo invÃ¡lido: ${scope}` });
      }
      const result = await ticketScheduler.generateMore(
        scope,
        Array.isArray(leagues) ? leagues : undefined,
        Number(limit) > 0 ? Number(limit) : 4,
        undefined,
        'jev'
      );
      await cacheDel(matchesApiCacheKey());
      let message = result.message;
      if (result.jevMeta) {
        const meta = result.jevMeta;
        message =
          `${message} JEV: ${meta.newPicks} decisÃ£o(Ãµes) nova(s), ` +
          `${meta.reused} reutilizada(s), ${meta.stale} antiga(s) descartada(s), ` +
          `${meta.apiCalls} chamada(s), custo ${meta.costUsd.toFixed(6)} USD.`;
      }
      res.json({
        ...result,
        message,
        all: withUploads(result.all),
        generated: withUploads(result.generated),
      });
    } catch (err: any) {
      res.status(502).json({ error: err?.message || 'Erro ao gerar fichas com JEV' });
    }
  });

  // Ficha manual: legs explÃ­citas escolhidas na lista de tips.
  app.post('/api/tickets/custom', async (req: Request, res: Response) => {
    try {
      const { scope = 'dia', tier = 'moderada', legs } = req.body || {};
      const validScopes = ['dia', '2_3_dias', 'longo'];
      const validTiers = ['segura', 'moderada', 'ousada', 'maluca', 'compostas'];
      if (!validScopes.includes(scope)) {
        return res.status(400).json({ error: `Escopo invÃ¡lido: ${scope}` });
      }
      if (!validTiers.includes(tier)) {
        return res.status(400).json({ error: `Tier invÃ¡lido: ${tier}` });
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
        return res.status(400).json({ error: `SeleÃ§Ã£o invÃ¡lida: ${invalid.market || '?'}` });
      }
      if (new Set(selections.map((s) => s.matchId)).size !== selections.length) {
        return res.status(400).json({ error: 'O mesmo jogo nÃ£o pode entrar duas vezes na ficha.' });
      }
      const now = Date.now();
      const matches = await marketService.getMatches(false);
      const byId = new Map(matches.map((m) => [m.id, m]));

      // Odds reais em falta: consulta a Premier Bet (sÃ³ API) para os mercados
      // que o feed do AiScore nÃ£o cobre (DC, over/under 1.5/3.5, DNB).
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
          errors.push(`jogo nÃ£o encontrado (${sel.matchId})`);
          return;
        }
        if (match.kickoffAt <= now) {
          errors.push(`${match.home} v ${match.away}: jogo jÃ¡ comeÃ§ou`);
          return;
        }
        let odds = match.odds;
        if (!odds.realMarkets?.includes(sel.market)) {
          const pbOdd = pbOddsByIndex.get(index);
          if (pbOdd) {
            if (isCompostaMarket(sel.market)) {
              odds = {
                ...odds,
                comboOdds: { ...(odds.comboOdds || {}), [sel.market]: pbOdd },
                realMarkets: Array.from(new Set([...(odds.realMarkets || []), sel.market])),
              } as MatchItem['odds'];
            } else {
              odds = {
                ...odds,
                [sel.market]: pbOdd,
                realMarkets: Array.from(new Set([...(odds.realMarkets || []), sel.market])),
              } as MatchItem['odds'];
            }
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
            `${match.home} v ${match.away}: sem odd real para "${labelForMarket(sel.market, { home: match.home, away: match.away })}"`
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
          error: errors.join('; ') || 'NÃ£o foi possÃ­vel precificar todas as seleÃ§Ãµes.',
        });
      }

      const slip = ticketEngine.createSlip(scope as SlipScope, tier as SlipTier, built, {
        customTitle: `Ficha manual (${built.length} jogos)`,
        rationale:
          'Ficha montada manualmente a partir das tips calculadas pelo motor; todas as odds sÃ£o reais.',
        isAiGenerated: false,
        engine: 'manual',
      });
      const added = ticketEngine.addCustomSlip(slip);
      // Persistência confirmada antes de responder (ficha manual).
      await bilheteriaDb.flush();
      await cacheDel(matchesApiCacheKey());

      res.json({
        slip: { ...added, upload: bilheteriaDb.getUpload(added.id) },
        all: withUploads(ticketEngine.getSlips()),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao criar ficha manual' });
    }
  });

  // ---------------------------------------------------------------- premier bet ---

  // ConfiguraÃ§Ã£o visÃ­vel ao frontend (sem expor credenciais).
  app.get('/api/premierbet/status', (req: Request, res: Response) => {
    res.json(premierBetStatus());
  });

  // Sobe uma ficha para a Premier Bet: login, boletim e (se nÃ£o for dry-run)
  // colocaÃ§Ã£o da aposta com o valor indicado em Kwanzas.
  app.post('/api/tickets/:id/upload', async (req: Request, res: Response) => {
    const slip = ticketEngine.getSlips().find((s) => s.id === req.params.id);
    if (!slip) {
      return res.status(404).json({ error: 'Ficha nÃ£o encontrada.' });
    }
    if (slip.status !== 'pendente') {
      return res.status(409).json({
        error: 'SÃ³ Ã© possÃ­vel subir fichas pendentes (ainda nÃ£o resolvidas ou expiradas).',
      });
    }
    if (uploadsInFlight.has(slip.id)) {
      return res.status(409).json({
        error: 'Esta ficha jÃ¡ estÃ¡ a ser subida para a Premier Bet. Aguarde o resultado.',
      });
    }

    const stake = Number(req.body?.stake);
    const status = premierBetStatus();
    if (!Number.isFinite(stake) || stake <= 0) {
      return res.status(400).json({ error: 'Indique um valor de aposta vÃ¡lido (em Kwanzas).' });
    }
    if (stake < status.minStake) {
      return res.status(400).json({ error: `O valor mÃ­nimo Ã© ${status.minStake} Kz.` });
    }
    if (status.maxStake > 0 && stake > status.maxStake) {
      return res.status(400).json({
        error: `O valor mÃ¡ximo configurado Ã© ${status.maxStake} Kz.`,
      });
    }

    const dryRun = Boolean(req.body?.dryRun) || status.dryRun;
    const force = req.body?.force === true;
    const existing = bilheteriaDb.getUpload(slip.id);

    if (!dryRun && existing?.status === 'placed' && !force) {
      return res.status(409).json({
        error: `Esta ficha jÃ¡ foi colocada na Premier Bet${
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
          'Esta ficha estÃ¡ a ser subida para a Premier Bet. Aguarde o resultado ou verifique as apostas abertas antes de tentar novamente.',
        upload: existing,
      });
    }
    if (!dryRun && !status.configured) {
      return res.status(503).json({
        error:
          'Credenciais da Premier Bet nÃ£o configuradas no servidor (PREMIERBET_LOGIN / PREMIERBET_PASSWORD).',
      });
    }
    if (!status.scriptExists) {
      return res.status(503).json({
        error: 'Bridge da Premier Bet nÃ£o encontrado no servidor (Scraping/premierbet_book.py).',
      });
    }

    uploadsInFlight.add(slip.id);
    let completedUpload: SlipUpload | null = null;
    try {
      // Registo de "em curso" ANTES de clicar em qualquer coisa: se o servidor
      // morrer a meio, o arranque seguinte marca a ficha como "por confirmar"
      // em vez de deixar margem para uma segunda aposta automÃ¡tica.
      if (!dryRun) {
        bilheteriaDb.saveUpload({
          slipId: slip.id,
          status: 'in_progress',
          stake,
          message: 'SubmissÃ£o em curso na Premier Bet...',
          at: Date.now(),
        });
        try {
          await bilheteriaDb.flush();
        } catch {
          /* a submissÃ£o continua; o resultado final volta a ser gravado */
        }
      }

      const result = await uploadSlipToPremierBet({ slip, stake, dryRun });

      // Ficha parcial: algumas pernas nÃ£o foram localizadas na Premier Bet e
      // a aposta seguiu com as disponÃ­veis. Sincroniza a ficha local com o
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
            `[PremierBet] Ficha ${slip.id}: ${before - kept.length} perna(s) nÃ£o localizada(s) removida(s); ficha sincronizada com ${kept.length} jogo(s).`
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
        // A colocaÃ§Ã£o jÃ¡ ficou registada; um erro ao responder ao cliente nÃ£o
        // pode transformar uma aposta colocada em "falhou" (permitiria duplicar).
        console.warn(
          `[PremierBet] Ficha ${slip.id}: resultado jÃ¡ registado (${completedUpload.status}); falha ao responder: ${err?.message}`
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
      console.warn(`[PremierBet] Ficha ${slip.id}: falha â€” ${message}`);
      return res
        .status(err instanceof PremierBetConfigError ? 503 : 502)
        .json({ error: message, upload: record });
    } finally {
      uploadsInFlight.delete(slip.id);
    }
  });

  // ------------------------------------------------------------- progressões ---

  app.get('/api/progressions', (_req: Request, res: Response) => {
    res.json(progressionEngine.list());
  });

  app.get('/api/progressions/:id', (req: Request, res: Response) => {
    const progression = progressionEngine.get(req.params.id);
    if (!progression) return res.status(404).json({ error: 'Progressão não encontrada.' });
    res.json(progression);
  });

  app.post('/api/progressions', (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const progression = progressionEngine.create({
        name: body.name,
        engine: body.engine,
        tier: body.tier,
        scope: body.scope,
        mode: body.mode,
        baseStake: Number(body.baseStake),
        reinvestPct: body.reinvestPct == null ? undefined : Number(body.reinvestPct),
        maxLevel: Number(body.maxLevel),
        targetOddsMin: Number(body.targetOddsMin),
        targetOddsMax: Number(body.targetOddsMax),
      });
      res.status(201).json(progression);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Configuração de progressão inválida.' });
    }
  });

  app.post('/api/progressions/:id/play', async (req: Request, res: Response) => {
    try {
      const progression = await progressionEngine.play(req.params.id);
      if (!progression) return res.status(404).json({ error: 'Progressão não encontrada.' });
      res.json(progression);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Falha ao iniciar a progressão.' });
    }
  });

  app.post('/api/progressions/:id/stop', (req: Request, res: Response) => {
    const progression = progressionEngine.pause(req.params.id);
    if (!progression) return res.status(404).json({ error: 'Progressão não encontrada.' });
    res.json(progression);
  });

  app.delete('/api/progressions/:id', (req: Request, res: Response) => {
    const deleted = progressionEngine.delete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Progressão não encontrada.' });
    res.json({ deleted: true, id: req.params.id });
  });

  // AI Tactical Analysis for a single match
  app.post('/api/ai/analyze-match', async (req: Request, res: Response) => {
    try {
      const { matchId } = req.body;
      const matches = await marketService.getMatches();
      const match = matches.find((m) => m.id === matchId);

      if (!match) {
        return res.status(404).json({ error: 'Partida nÃ£o encontrada' });
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

  // Placar REAL (FT/HT + status) â€” fonte da verdade para expiraÃ§Ã£o de bilhetes
  app.get('/api/aiscore/live/:id', async (req: Request, res: Response) => {
    try {
      if (!/^[A-Za-z0-9_-]{4,64}$/.test(req.params.id)) {
        return res.status(400).json({ error: 'match id invÃ¡lido' });
      }
      const live = await aiscoreClient.getLiveResult(req.params.id);
      if (!live) return res.status(404).json({ error: 'Sem placar real disponÃ­vel' });
      res.json({ ok: true, data: live });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao consultar placar real' });
    }
  });

  // ForÃ§a um ciclo de resoluÃ§Ã£o real sob demanda (placar AiScore + validaÃ§Ã£o).
  // Rate-limit 60s: cada ciclo consome throttle do bridge (~1.7s por jogo).
  let lastResolveDueAt = 0;
  app.post('/api/matches/resolve-due', async (req: Request, res: Response) => {
    try {
      if (Date.now() - lastResolveDueAt < 60_000) {
        return res.status(429).json({ error: 'Aguarde 60s entre ciclos de resoluÃ§Ã£o.' });
      }
      lastResolveDueAt = Date.now();
      const resolved = await marketService.resolveDueMatches(8);
      const { updatedSlips } = ticketEngine.validateSlips();
      res.json({ resolved, updatedSlips, allSlips: ticketEngine.getSlips() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao resolver com placar real' });
    }
  });

  // MatchContext pronto para o motor (H2H/forma/importÃ¢ncia/descanso)
  app.get('/api/aiscore/context', async (req: Request, res: Response) => {
    try {
      const { home, away, date } = req.query as Record<string, string>;
      if (!home || !away || !date) {
        return res.status(400).json({ error: 'ParÃ¢metros obrigatÃ³rios: home, away, date' });
      }
      const meta = await aiscoreClient.resolveMatchId(home, away, date);
      if (!meta?.match_id) {
        return res.status(404).json({ error: 'Partida nÃ£o encontrada no AiScore' });
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

    // Agendador em background: fichas do dia Ã  meia-noite (Angola), reposiÃ§Ã£o de
    // estoque, expiraÃ§Ã£o e sincronizaÃ§Ã£o de mercado â€” funciona sem browser aberto.
    ticketScheduler.start();
    progressionEngine.start();

    // Quando o backfill dos dias +1..+8 termina, repÃµe as quotas dos escopos
    // futuros (2-3 dias / longo) sem esperar o prÃ³ximo tick.
    marketService.onAiscoreBackfillDone(() => {
      void ticketScheduler.tick('aiscore-backfill');
    });
  });

  const shutdown = async (signal: string) => {
    console.log(`[Bilheteria Backend] ${signal} recebido. A encerrar agendador e a gravar estado...`);
    ticketScheduler.stop();
    progressionEngine.stop();
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

