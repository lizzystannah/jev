import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { marketService } from './server/marketService.js';
import { ticketEngine } from './server/ticketEngine.js';
import { ticketScheduler } from './server/ticketScheduler.js';
import { bilheteriaDb } from './server/db.js';
import { analyzeMatchTactics, generateSmartSlipWithAi } from './server/aiService.js';
import { aiscoreClient, decodePackedSint32, parseMatchScores, scoutToMatchContext } from './server/aiscoreService.js';
import { getLocalCumulativeMetrics, AISCORE_ENGINE_VERSION } from './server/aiscoreEngine.js';
import type { BetSlip, SlipUpload } from './server/types.js';
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

  // Matches list (leitura segura do cache sem disparar fetch involuntário)
  app.get('/api/matches', async (req: Request, res: Response) => {
    try {
      const forceRefresh = req.query.refresh === 'true';
      const matches = await marketService.getMatches(forceRefresh);
      res.json(matches);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao carregar jogos' });
    }
  });

  // Sincronização explícita e protegida com The Odds API (disparada intencionalmente pelo usuário)
  app.post('/api/market/sync-odds', async (req: Request, res: Response) => {
    try {
      const matches = await marketService.getMatches(true);
      const status = marketService.getProviderStatus();
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

  // Slips list
  app.get('/api/tickets', (req: Request, res: Response) => {
    // Run validation sweep before returning
    ticketEngine.validateSlips();
    res.json(withUploads(ticketEngine.getSlips()));
  });

  // Stock/quota status (usado pelo frontend e por monitorização)
  app.get('/api/tickets/stock', (req: Request, res: Response) => {
    res.json(ticketScheduler.getStatus());
  });

  // Generate slips for scope (botão manual em qualquer parte do site)
  app.post('/api/tickets/generate', async (req: Request, res: Response) => {
    try {
      const { scope = 'dia', leagues, limit } = req.body || {};
      const validScopes = ['dia', '2_3_dias', 'longo'];
      if (!validScopes.includes(scope)) {
        return res.status(400).json({ error: `Escopo inválido: ${scope}` });
      }
      const result = await ticketScheduler.generateMore(
        scope,
        Array.isArray(leagues) ? leagues : undefined,
        Number(limit) > 0 ? Number(limit) : 2
      );
      res.json({
        ...result,
        all: withUploads(result.all),
        generated: withUploads(result.generated),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Erro ao gerar bilhetes' });
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
    const force = Boolean(req.body?.force);
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
      console.log(
        `[PremierBet] Ficha ${slip.id}: ${uploadStatus} (${result.durationMs ?? 0} ms).`
      );
      return res.json({ ...result, upload: record });
    } catch (err: any) {
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
