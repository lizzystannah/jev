<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Bilheteria — motor de bilhetes

Backend sempre ativo que gera, persiste e resolve fichas (bilhetes) de apostas
a partir de jogos reais (AiScore + odds de mercado).

## Fichas automáticas e persistentes

- **Fichas do dia**: todos os dias às **00:00 de Angola** (`Africa/Luanda`), o
  agendador cria automaticamente a fornada de fichas de "Hoje" (default: 5).
- **Estoque por horizonte**: mantém um mínimo de fichas pendentes —
  Hoje = 5, 2 a 3 dias = 5, Longo prazo = 5 (configurável em `.env`).
  Sempre que uma ficha cai (ganha/perde/expira), o agendador **repõe** o estoque.
- **Só odds reais**: jogos sem odds 1X2 do fornecedor podem entrar no horizonte
  para receber preços da Premier Bet, mas não geram tips nem fichas até existir
  preço real. Não há preenchimento com odds fixas "inventadas"; mercados
  derivados (dupla chance, DNB, etc.) ficam marcados e não são usados para
  montar fichas.
- **Persistência na base de dados**: as fichas vivem numa base de dados **MySQL**
  configurada por variáveis de ambiente (`MYSQL_HOST`, `MYSQL_PORT`,
  `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`) ou, quando não há MySQL,
  em **SQLite** no caminho `BILHETERIA_DB_PATH`. No Docker o default é
  `/data/bilheteria.db`, dentro do volume nomeado que preserva as fichas.
- **Histórico** com abas: **Ganhas**, **Perdidas**, **Vencidas/Expiradas** e
  **Em andamento**. Lista compacta (expandir por linha) com data de criação.
- **Botão "Gerar"** disponível a partir de qualquer parte do site (cabeçalho,
  hero e botão flutuante).
- **Subir para a Premier Bet**: cada ficha pendente tem um botão **Subir** que
  entra em `premierbet.co.ao`, localiza os jogos, preenche as tips, define o
  valor da aposta e coloca a ficha no ar. O valor é pedido num modal (Kz).

O agendador corre **dentro do servidor**: funciona mesmo com o site fechado.

## Base de dados (MySQL)

Toda a configuração vem da env:

| Variável | Exemplo | Obrigatória |
| --- | --- | --- |
| `MYSQL_HOST` | `127.0.0.1` | sim |
| `MYSQL_PORT` | `3306` | não (default `3306`) |
| `MYSQL_USER` | `bilheteria` | sim |
| `MYSQL_PASSWORD` | `segredo` | não (pode ser vazia) |
| `MYSQL_DATABASE` | `bilheteria` | sim |
| `MYSQL_SSL` | `1` | não (default desligado) |

O schema (`slips` + `meta` + `slip_uploads`) é criado automaticamente no
arranque, na base de dados indicada em `MYSQL_DATABASE` (tem de existir). As
escritas são serializadas (write-behind) e descarregadas no shutdown.

Se `MYSQL_HOST`, `MYSQL_USER` e `MYSQL_DATABASE` estiverem vazios, o servidor
usa SQLite local em `.data/bilheteria.db` apenas para desenvolvimento. Se apenas
parte deles estiver preenchida, o arranque falha com uma mensagem a indicar o
que falta.

## Subir fichas para a Premier Bet

O botão **Subir** (em cada ficha pendente, no cartão ou no histórico) abre um
modal para definir o **valor da aposta em Kwanzas (AOA)** e, opcionalmente,
testar o boletim sem apostar.

Ao confirmar, o servidor:

1. faz login em `https://www.premierbet.co.ao/` com as credenciais da env;
2. localiza cada jogo da ficha na API da Premier Bet (nomes + data) e lê os
   mercados/odds atuais;
3. injeta as seleções no boletim, define o valor e coloca a aposta;
4. guarda o resultado em `slip_uploads` (estado, valor, ID da aposta).

O browser corre no servidor (Playwright/Chromium), por isso o site pode estar
fechado no teu computador. A operação pode demorar 1–3 minutos.

### Credenciais e segurança

| Variável | Default | Descrição |
| --- | --- | --- |
| `PREMIERBET_LOGIN` | *(vazio)* | Telefone (`244...`), utilizador ou email da conta |
| `PREMIERBET_PASSWORD` | *(vazio)* | Palavra-passe da conta Premier Bet |
| `PREMIERBET_DRY_RUN` | `0` | `1` força o modo de teste em todos os pedidos (não aposta) |
| `PREMIERBET_DEFAULT_STAKE` | `1000` | Valor sugerido no modal (Kz) |
| `PREMIERBET_MIN_STAKE` | `1` | Valor mínimo aceite pela API (Kz) |
| `PREMIERBET_MAX_STAKE` | *(sem limite)* | Valor máximo aceite pela API (Kz) |
| `PREMIERBET_TIMEOUT_MS` | `300000` | Tempo máximo da automação (5 min) |
| `PREMIERBET_HEADFUL` | `0` | `1` mostra o browser (debug local) |
| `PREMIERBET_NO_SANDBOX` | `0` | `1` adiciona `--no-sandbox` ao Chromium (contentores) |
| `PREMIERBET_PYTHON` | `AISCORE_PYTHON` | Python com `playwright` + `curl_cffi` |

As credenciais **nunca** são escritas em ficheiros nem em argumentos de linha de
comando: seguem apenas no ambiente do processo Python.

> **Aviso:** a aplicação não tem autenticação própria e o botão **Subir** coloca
> **dinheiro real**. Não exponhas a porta do servidor à internet sem um proxy ou
> uma rede privada com autenticação.

**Proteção contra apostas duplicadas:** uma ficha já colocada fica marcada como
**No ar** e não pode ser reenviada sem confirmação explícita. Se a Premier Bet
não confirmar a colocação, o estado fica **por confirmar** e o sistema não repete
a aposta automaticamente — verifica primeiro as apostas abertas na conta. Se o
servidor reiniciar a meio de uma submissão, o registo **em curso** é convertido
em **por confirmar** no arranque seguinte (nunca é reenviado sozinho).

### Instalação local do browser

```bash
pip install playwright
python -m playwright install chromium
```

Em Docker a imagem já inclui Playwright + Chromium (a imagem fica maior).

## Requisitos

- **Node.js 24+** (o fallback local usa `node:sqlite`).
- **MySQL 5.7+ / 8.0+ / MariaDB 10.5+** (em produção).
- Python com `curl_cffi` (bridge AiScore) e `playwright` + Chromium
  (automação Premier Bet).

## Correr localmente

```bash
npm install
# define a BD MySQL em .env:
#   MYSQL_HOST="127.0.0.1"
#   MYSQL_PORT="3306"
#   MYSQL_USER="bilheteria"
#   MYSQL_PASSWORD="segredo"
#   MYSQL_DATABASE="bilheteria"
npm run dev        # desenvolvimento
# ou
npm start          # servidor de produção local
```

Para garantir que o servidor fica **sempre ativo** (reinicia se cair):

```bash
npm run start:always      # PowerShell (Windows)
npm run start:always:bat  # Batch (Windows)
```

Ou com um gestor de processos (produção):

```bash
npx pm2 start "npm start" --name bilheteria
```

## Tiers de fichas

O motor gera quatro categorias por horizonte, com uma vaga reservada para cada uma:

| Tier | Alvo | Construção |
| --- | --- | --- |
| **Segura** | 3x | Tips de probabilidade calibrada alta; o número de jogos é o necessário para chegar ao alvo |
| **Moderada** | 15x | Tips de risco moderado; mais jogos e odds individuais controladas, sem pernas artificiais |
| **Ousada** | 100x | Tips de odds controladas; o alvo é alcançado acumulando mais jogos, não inventando odds altas |
| **Maluca** | 250x | 4 a 8 jogos, odds entre 1.75x e 3.0x e probabilidade minima de 25%, escolhidas por probabilidade/forma |

O motor calcula primeiro uma tip para **todos os jogos com odds reais** do horizonte e, para cada jogo, também uma tip alternativa de mercado real com odd entre 1.75x e 3.0x e probabilidade minima de 25%. A ficha é apenas uma seleção dessas tips: ordena por probabilidade, acrescenta jogos até a odd combinada atingir o alvo e pára. Se não houver tips suficientes para o alvo, **não é criada uma ficha forçada** — nunca se inventa uma perna de odd alta para "completar pontos".

As ligas elegíveis incluem as principais (Champions, Europa, Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Primeira Liga, Brasileirão) e ainda **Conference League, J1 League (Japão), Süper Lig (Turquia) e Saudi Pro League**. Divisões inferiores, femininos e ligas juvenis ficam de fora.

Todas as pernas usam apenas mercados com odds reais (`odds.realMarkets`). O motor local pode calcular probabilidades a partir do scout, mas nunca inventa um preço para preencher uma ficha.

## Sprint 0 (consolidação do motor)

- **Configuração única** (`server/config.ts`): alvos, faixas, quotas, piso de odd e versão do motor deixam de estar duplicados. `TICKETS_*`, `AISCORE_*` e `TICKETS_EXCLUDE_MARKET_ONLY` continuam a funcionar.
- **Motor v5** (`server/scoreModel.ts`): uma única matriz de placares Poisson + Dixon-Coles alimenta 1X2, over/under e BTTS. As taxas empíricas/H2H só escalam o λ total (±10%), sem dupla contagem.
- **Piso do motor 1.10**: a seleção aceita odds a partir de 1.10; as fichas continuam a impor o seu mínimo (`TICKETS_MIN_LEG_ODD`, default **1.25**), pelo que tips entre 1.10 e 1.25 podem ser calculadas mas não entram em fichas.
- **Fallback sem scout**: `modelBasis='market'` calcula p a partir das odds reais sem margem e confiança ≤ 0.3; por defeito estes jogos ficam fora das fichas (`TICKETS_EXCLUDE_MARKET_ONLY=0` permite incluí-los). Jogos sem dados (`modelBasis='none'`) ou sem odd real acima do piso (`priced=false`) nunca entram.
- **Liquidação central** (`server/slipSettlement.ts`): push/void passam a ser neutros. Uma ficha com todas as pernas anuladas fica `anulada` (stake devolvida) e não conta como perda nas progressões. A odd efetiva (`effectiveOdds`) exclui as pernas void.
- **Mutual exclusion global** (`server/mutex.ts`): geração de fichas serializada entre rotas HTTP, agendador e progressões.
- **Avaliações puras**: `evaluateOne` não muta o `MatchItem`; cada chamada recalcula as probabilidades de raiz.
- **Compostas**: lidas diretamente da matriz final (`compostaProbsFromMatrix`), depois do ajuste IPF de 1X2/over 2.5/BTTS, para não haver dupla contagem nem incoerência entre mercados.
- **Qualidade**: `npm test` (Vitest) e `npm run check:encoding` (deteta mojibake).

## Motores e abas (Principal, Manual, JEV)

A interface tem três abas independentes, para comparar a eficiência de cada abordagem:

- **Principal** — motor local (faixa de probabilidade). Gera as fichas segura/moderada/ousada/maluca por horizonte, com o histórico próprio.
- **Manual** — escolhes jogos/tips já calculados, adicionas ao carrinho e crias a ficha (`POST /api/tickets/custom`, `engine='manual'`).
- **JEV** — o modelo de decisão recebe apenas o essencial de cada jogo (tips candidatas com probabilidade do motor local + odds reais) e escolhe a tip. As fichas são marcadas `engine='jev'` e têm histórico separado; a comparação Principal vs JEV aparece na própria aba.

Configuração do JEV (TypeSafe **Decisions API** — modelo de decisão, não chat completions):

```env
JEV_API_KEY=              # vazio usa OPENROUTER_API_KEY
JEV_MODEL=                # default typesafe/jev-1.14
JEV_DECISIONS_URL=        # opcional; default https://openrouter.ai/api/alpha/decisions
JEV_API_URL=              # alias (menos prioritário) para o endpoint
JEV_TIMEOUT_MS=60000
JEV_REUSE_DECISIONS=1      # 1 reutiliza decisoes guardadas; 0 forca novas chamadas
```

O JEV recebe um `state` com os jogos e, por jogo, uma pergunta `choice` cujas opcoes sao as tips candidatas (probabilidade do motor local + odd real). Devolve o mercado escolhido e a confianca, sem texto livre. As decisoes ficam persistidas na calibracao do jogo e sao reutilizadas enquanto as odds nao mudarem.

Cada geracao devolve no `message` (e nos logs `[JEV] ... custo X USD`) quantas decisoes foram novas, quantas foram reutilizadas e o custo da chamada.

## Cache (Redis opcional)

`GET /api/matches` é cacheado (25s) para a navegação entre abas não recalcular ~1600 jogos. O cache usa memória do processo por omissão; com `REDIS_URL` definido usa Redis (o `docker-compose.yml` já inclui o serviço `redis`). Sem o pacote/serviço Redis, cai automaticamente para memória.

## Configuração (`.env`)

Ver `.env.example`. Chaves relevantes:

| Variável | Default | Descrição |
| --- | --- | --- |
| `MYSQL_HOST` | *(vazio)* | Host do MySQL (obrigatório em produção) |
| `MYSQL_PORT` | `3306` | Porta do MySQL |
| `MYSQL_USER` | *(vazio)* | Utilizador do MySQL |
| `MYSQL_PASSWORD` | *(vazio)* | Password do MySQL |
| `MYSQL_DATABASE` | *(vazio)* | Nome da base de dados (deve existir) |
| `MYSQL_SSL` | *(desligado)* | `1` liga SSL na ligação ao MySQL |
| `BILHETERIA_DB_PATH` | `.data/bilheteria.db` | SQLite local (só fallback de dev) |
| `TICKETS_QUOTA_DIA` | `5` | Estoque mínimo de fichas de Hoje (uma por tier) |
| `TICKETS_QUOTA_MED` | `5` | Estoque mínimo de 2 a 3 dias (uma por tier) |
| `TICKETS_QUOTA_LONGO` | `5` | Estoque mínimo de longo prazo (uma por tier) |
| `TICKETS_TARGET_SEGURA` | `3` | Alvo de odd combinada da ficha Segura |
| `TICKETS_TARGET_MODERADA` | `15` | Alvo de odd combinada da ficha Moderada |
| `TICKETS_TARGET_OUSADA` | `100` | Alvo de odd combinada da ficha Ousada |
| `TICKETS_TARGET_MALUCA` | `250` | Alvo de odd combinada da ficha Maluca |
| `TICKETS_MAX_LEGS_SEGURA` | `12` | Teto de jogos da Segura |
| `TICKETS_MAX_LEGS_MODERADA` | `18` | Teto de jogos da Moderada |
| `TICKETS_MAX_LEGS_OUSADA` | `26` | Teto de jogos da Ousada |
| `TICKETS_MAX_LEGS_MALUCA` | `8` | Teto de jogos da Maluca (minimo 4) |
| `TICKETS_MIN_LEG_ODD` | `1.25` | Odd minima por perna nas fichas |
| `TICKETS_EXCLUDE_MARKET_ONLY` | `1` | Exclui jogos sem scout (`modelBasis='market'`) das fichas |
| `AISCORE_LOG` | `1` | Log de cada avaliação do motor local |
| `AISCORE_TIE_EPS` | `0` | Tolerância de empate na faixa; 0 = a odd nunca decide |
| `AISCORE_NO_BAND_FALLBACK` | `maxP` | Sem candidato na faixa: `maxP` ou `closest` |
| `AISCORE_FLAG_HT_ADJ` | `0` | Ativa ajuste de ritmo da 1.ª parte (experimental) |
| `TICKETS_NON_MALUCA_MIN_PROB` | `40` | Probabilidade minima (%) por perna nas fichas Segura/Moderada/Ousada |
| `TICKETS_MALUCA_MIN_LEG_ODD` | `1.75` | Odd minima por perna da Maluca |
| `TICKETS_MALUCA_MAX_LEG_ODD` | `3.0` | Odd maxima por perna da Maluca |
| `TICKETS_MALUCA_MIN_PROB` | `25` | Probabilidade minima (%) por perna da Maluca |
| `TICKETS_EXPIRY_GRACE_HOURS` | `6` | Tolerância após o último jogo antes de marcar como vencida |
| `PREMIERBET_LOGIN` | *(vazio)* | Login da conta Premier Bet |
| `PREMIERBET_PASSWORD` | *(vazio)* | Password da conta Premier Bet |
| `PREMIERBET_DRY_RUN` | `0` | `1` força modo de teste (não aposta) |
| `PREMIERBET_DEFAULT_STAKE` | `1000` | Valor sugerido no modal (Kz) |

## API

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/api/tickets` | Lista todas as fichas (persistidas, com estado Premier Bet) |
| GET | `/api/tickets/stock` | Estoque/quotas e estado do agendador |
| POST | `/api/tickets/generate` | Gera fichas extra (`{ scope, leagues, limit }`) |
| POST | `/api/tickets/:id/upload` | Sobe a ficha para a Premier Bet (`{ stake, dryRun?, force? }`) |
| GET | `/api/premierbet/status` | Configuração visível da Premier Bet (sem credenciais) |
| POST | `/api/matches/reset` | Limpa tudo e repõe o estoque |
| GET | `/api/status` | Estado do servidor (inclui `tickets`) |

## Docker

Node 24 é obrigatório. O container lê a configuração de `.env` (`env_file`) e
pode persistir as fichas no MySQL configurado ou num volume SQLite.

```bash
docker build -t bilheteria:latest .
docker run --rm -p 3000:3000 \
  -v bilheteria_data:/data \
  -e BILHETERIA_DB_PATH="/data/bilheteria.db" \
  -e MYSQL_HOST="host-do-mysql" \
  -e MYSQL_PORT="3306" \
  -e MYSQL_USER="bilheteria" \
  -e MYSQL_PASSWORD="segredo" \
  -e MYSQL_DATABASE="bilheteria" \
  -e PREMIERBET_LOGIN="244..." \
  -e PREMIERBET_PASSWORD="segredo" \
  bilheteria:latest
```

Também podes usar `--env-file .env` em vez de `-e` (nunca coloques segredos no
`Dockerfile` nem no repositório). A imagem inclui Playwright + Chromium para a
automação da Premier Bet; `PREMIERBET_NO_SANDBOX=1` já vem ativo no container.

## Deploy e persistência das fichas

O `docker-compose.yml` na raiz sobe o container já com um volume nomeado
(`bilheteria_data`) montado em `/data` e `BILHETERIA_DB_PATH=/data/bilheteria.db`.

```bash
docker compose up -d --build     # construir e subir
docker compose logs -f           # acompanhar os logs
docker compose restart           # restart: as fichas mantêm-se
```

- **Restart e redeploy mantêm as fichas**: o volume nomeado sobrevive a
  `docker compose restart`, `up -d --build`, recriação do container e
  `docker compose down`.
- **Mudar `.env`** (credenciais, quotas, MySQL, etc.) exige recriar o container:

  ```bash
  docker compose up -d --force-recreate
  ```

- **`docker compose down -v` APAGA tudo**: remove o volume e, com ele, todas as
  fichas guardadas em SQLite. Usa só quando quiseres começar do zero.
- **MySQL**: se preencheres `MYSQL_*` no `.env`, a persistência passa a ser o
  MySQL e o volume deixa de ser necessário para as fichas. O bloco opcional
  está comentado no `docker-compose.yml`.
- **Sem volume e sem MySQL**, o SQLite fica no sistema de ficheiros efémero do
  container: as fichas vivem só enquanto o container existir e perdem-se no
  próximo redeploy/recriação.


## Validacao de resultados

- A cada minuto, as pernas das fichas PENDENTES sao verificadas via `match/data` (prioridade).
- A cada `RESULTS_SWEEP_MINUTES` (default 15) corre uma varredura em massa: UMA chamada `matches?date=` traz `statusId` + placares de todos os jogos do dia. So se aplicam jogos terminados (`statusId 8` / `matchStatus 3`) com placar valido.
- Inclui o dia anterior (jogos que terminam depois da meia-noite).
- Antes de criar as fichas do dia (00:00), a varredura corre primeiro e as fichas sao validadas.
- Pernas com push/reembolso (ex.: DNB empatado) ficam `void`: nao contam como acerto nem como perda. Se todas as pernas forem void, a ficha fica `anulada`.

### Montagem atualizada das fichas

- Segura/Moderada/Ousada usam tips reais com odd entre `TICKETS_MIN_LEG_ODD` (1.25) e `TICKETS_MAX_LEG_ODD` (2.20) e probabilidade minima de `TICKETS_NON_MALUCA_MIN_PROB` (40%). Cada tier escolhe o perfil de odd que lhe compete (Segura = maior probabilidade; Moderada = equilibrio; Ousada = maior odd da faixa); tips abaixo de 1.25 são calculadas pelo motor mas não entram nestas fichas. A pontuacao total (3x/15x/100x) e alcancada **acumulando mais jogos**, nunca com uma perna de odd alta.
- Maluca escolhe pernas reais com odd entre 1.75x e 3.0x e probabilidade minima de 25% (`highRiskTip` quando disponivel), alvo de 250x em 4 a 8 jogos; sem odds extremas.
- No JEV, as fichas nao-Maluca so escolhem entre tips dentro dessa faixa; a Maluca mantem a tip alternativa dentro da faixa 1.75x-3.0x.

### Anti-repeticao entre fichas

- Um jogo pode entrar em no maximo `TICKETS_MAX_SLIPS_PER_MATCH` fichas pendentes (default 2).
- Se uma ficha precisar de repetir um jogo, usa no maximo `TICKETS_MAX_REUSED_LEGS` jogos repetidos (default 8) e **sempre com mercado/tip diferente** do que ja foi usado nesse jogo.
- Se nao houver jogos frescos suficientes dentro da faixa de odds, o motor **nao cria** a ficha em vez de correlacionar varias fichas nos mesmos jogos.
