<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Bilheteria Ã¢â‚¬â€ motor de bilhetes

Backend sempre ativo que gera, persiste e resolve fichas (bilhetes) de apostas
a partir de jogos reais (AiScore + odds de mercado).

## Fichas automÃƒÂ¡ticas e persistentes

- **Fichas do dia**: todos os dias ÃƒÂ s **00:00 de Angola** (`Africa/Luanda`), o
  agendador cria automaticamente a fornada de fichas de "Hoje" (default: 4).
- **Estoque por horizonte**: mantÃƒÂ©m um mÃƒÂ­nimo de fichas pendentes Ã¢â‚¬â€
  Hoje = 4, 2 a 3 dias = 4, Longo prazo = 4 (configurÃƒÂ¡vel em `.env`).
  Sempre que uma ficha cai (ganha/perde/expira), o agendador **repÃƒÂµe** o estoque.
- **SÃƒÂ³ odds reais**: jogos sem odds 1X2 do fornecedor nÃƒÂ£o entram no mercado.
  NÃƒÂ£o hÃƒÂ¡ preenchimento com odds fixas "inventadas"; mercados derivados
  (dupla chance, DNB, etc.) ficam marcados e nÃƒÂ£o sÃƒÂ£o usados para montar fichas.
- **PersistÃƒÂªncia na base de dados**: as fichas vivem numa base de dados **MySQL**
  configurada por variÃƒÂ¡veis de ambiente (`MYSQL_HOST`, `MYSQL_PORT`,
  `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`) ou, quando nÃƒÂ£o hÃƒÂ¡ MySQL,
  em **SQLite** no caminho `BILHETERIA_DB_PATH`. No Docker o default ÃƒÂ©
  `/data/bilheteria.db`, dentro do volume nomeado que preserva as fichas.
- **HistÃƒÂ³rico** com abas: **Ganhas**, **Perdidas**, **Vencidas/Expiradas** e
  **Em andamento**. Lista compacta (expandir por linha) com data de criaÃƒÂ§ÃƒÂ£o.
- **BotÃƒÂ£o "Gerar"** disponÃƒÂ­vel a partir de qualquer parte do site (cabeÃƒÂ§alho,
  hero e botÃƒÂ£o flutuante).
- **Subir para a Premier Bet**: cada ficha pendente tem um botÃƒÂ£o **Subir** que
  entra em `premierbet.co.ao`, localiza os jogos, preenche as tips, define o
  valor da aposta e coloca a ficha no ar. O valor ÃƒÂ© pedido num modal (Kz).

O agendador corre **dentro do servidor**: funciona mesmo com o site fechado.

## Base de dados (MySQL)

Toda a configuraÃƒÂ§ÃƒÂ£o vem da env:

| VariÃƒÂ¡vel | Exemplo | ObrigatÃƒÂ³ria |
| --- | --- | --- |
| `MYSQL_HOST` | `127.0.0.1` | sim |
| `MYSQL_PORT` | `3306` | nÃƒÂ£o (default `3306`) |
| `MYSQL_USER` | `bilheteria` | sim |
| `MYSQL_PASSWORD` | `segredo` | nÃƒÂ£o (pode ser vazia) |
| `MYSQL_DATABASE` | `bilheteria` | sim |
| `MYSQL_SSL` | `1` | nÃƒÂ£o (default desligado) |

O schema (`slips` + `meta` + `slip_uploads`) ÃƒÂ© criado automaticamente no
arranque, na base de dados indicada em `MYSQL_DATABASE` (tem de existir). As
escritas sÃƒÂ£o serializadas (write-behind) e descarregadas no shutdown.

Se `MYSQL_HOST`, `MYSQL_USER` e `MYSQL_DATABASE` estiverem vazios, o servidor
usa SQLite local em `.data/bilheteria.db` apenas para desenvolvimento. Se apenas
parte deles estiver preenchida, o arranque falha com uma mensagem a indicar o
que falta.

## Subir fichas para a Premier Bet

O botÃƒÂ£o **Subir** (em cada ficha pendente, no cartÃƒÂ£o ou no histÃƒÂ³rico) abre um
modal para definir o **valor da aposta em Kwanzas (AOA)** e, opcionalmente,
testar o boletim sem apostar.

Ao confirmar, o servidor:

1. faz login em `https://www.premierbet.co.ao/` com as credenciais da env;
2. localiza cada jogo da ficha na API da Premier Bet (nomes + data) e lÃƒÂª os
   mercados/odds atuais;
3. injeta as seleÃƒÂ§ÃƒÂµes no boletim, define o valor e coloca a aposta;
4. guarda o resultado em `slip_uploads` (estado, valor, ID da aposta).

O browser corre no servidor (Playwright/Chromium), por isso o site pode estar
fechado no teu computador. A operaÃƒÂ§ÃƒÂ£o pode demorar 1Ã¢â‚¬â€œ3 minutos.

### Credenciais e seguranÃƒÂ§a

| VariÃƒÂ¡vel | Default | DescriÃƒÂ§ÃƒÂ£o |
| --- | --- | --- |
| `PREMIERBET_LOGIN` | *(vazio)* | Telefone (`244...`), utilizador ou email da conta |
| `PREMIERBET_PASSWORD` | *(vazio)* | Palavra-passe da conta Premier Bet |
| `PREMIERBET_DRY_RUN` | `0` | `1` forÃƒÂ§a o modo de teste em todos os pedidos (nÃƒÂ£o aposta) |
| `PREMIERBET_DEFAULT_STAKE` | `1000` | Valor sugerido no modal (Kz) |
| `PREMIERBET_MIN_STAKE` | `1` | Valor mÃƒÂ­nimo aceite pela API (Kz) |
| `PREMIERBET_MAX_STAKE` | *(sem limite)* | Valor mÃƒÂ¡ximo aceite pela API (Kz) |
| `PREMIERBET_TIMEOUT_MS` | `300000` | Tempo mÃƒÂ¡ximo da automaÃƒÂ§ÃƒÂ£o (5 min) |
| `PREMIERBET_HEADFUL` | `0` | `1` mostra o browser (debug local) |
| `PREMIERBET_NO_SANDBOX` | `0` | `1` adiciona `--no-sandbox` ao Chromium (contentores) |
| `PREMIERBET_PYTHON` | `AISCORE_PYTHON` | Python com `playwright` + `curl_cffi` |

As credenciais **nunca** sÃƒÂ£o escritas em ficheiros nem em argumentos de linha de
comando: seguem apenas no ambiente do processo Python.

> **Aviso:** a aplicaÃƒÂ§ÃƒÂ£o nÃƒÂ£o tem autenticaÃƒÂ§ÃƒÂ£o prÃƒÂ³pria e o botÃƒÂ£o **Subir** coloca
> **dinheiro real**. NÃƒÂ£o exponhas a porta do servidor ÃƒÂ  internet sem um proxy ou
> uma rede privada com autenticaÃƒÂ§ÃƒÂ£o.

**ProteÃƒÂ§ÃƒÂ£o contra apostas duplicadas:** uma ficha jÃƒÂ¡ colocada fica marcada como
**No ar** e nÃƒÂ£o pode ser reenviada sem confirmaÃƒÂ§ÃƒÂ£o explÃƒÂ­cita. Se a Premier Bet
nÃƒÂ£o confirmar a colocaÃƒÂ§ÃƒÂ£o, o estado fica **por confirmar** e o sistema nÃƒÂ£o repete
a aposta automaticamente Ã¢â‚¬â€ verifica primeiro as apostas abertas na conta. Se o
servidor reiniciar a meio de uma submissÃƒÂ£o, o registo **em curso** ÃƒÂ© convertido
em **por confirmar** no arranque seguinte (nunca ÃƒÂ© reenviado sozinho).

### InstalaÃƒÂ§ÃƒÂ£o local do browser

```bash
pip install playwright
python -m playwright install chromium
```

Em Docker a imagem jÃƒÂ¡ inclui Playwright + Chromium (a imagem fica maior).

## Requisitos

- **Node.js 24+** (o fallback local usa `node:sqlite`).
- **MySQL 5.7+ / 8.0+ / MariaDB 10.5+** (em produÃƒÂ§ÃƒÂ£o).
- Python com `curl_cffi` (bridge AiScore) e `playwright` + Chromium
  (automaÃƒÂ§ÃƒÂ£o Premier Bet).

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
npm start          # servidor de produÃƒÂ§ÃƒÂ£o local
```

Para garantir que o servidor fica **sempre ativo** (reinicia se cair):

```bash
npm run start:always      # PowerShell (Windows)
npm run start:always:bat  # Batch (Windows)
```

Ou com um gestor de processos (produÃƒÂ§ÃƒÂ£o):

```bash
npx pm2 start "npm start" --name bilheteria
```

## Tiers de fichas

O motor gera quatro categorias por horizonte, com uma vaga reservada para cada uma:

| Tier | Alvo | ConstruÃƒÂ§ÃƒÂ£o |
| --- | --- | --- |
| **Segura** | 3x | Tips de probabilidade calibrada alta; o nÃƒÂºmero de jogos ÃƒÂ© o necessÃƒÂ¡rio para chegar ao alvo |
| **Moderada** | 15x | Tips de risco moderado; mais jogos e odds individuais controladas, sem pernas artificiais |
| **Ousada** | 100x | Tips de odds controladas; o alvo ÃƒÂ© alcanÃƒÂ§ado acumulando mais jogos, nÃƒÂ£o inventando odds altas |
| **Maluca** | 1000x | 4Ã¢â‚¬â€œ8 jogos de odd alta, usando a tip alternativa de odd alta calculada pelo motor para cada jogo |

O motor calcula primeiro uma tip para **todos os jogos com odds reais** do horizonte e, para cada jogo, tambÃƒÂ©m uma tip alternativa de odd alta (outro mercado real do mesmo jogo). A ficha ÃƒÂ© apenas uma seleÃƒÂ§ÃƒÂ£o dessas tips: ordena por probabilidade, acrescenta jogos atÃƒÂ© a odd combinada atingir o alvo e pÃƒÂ¡ra. Se nÃƒÂ£o houver tips suficientes para o alvo, **nÃƒÂ£o ÃƒÂ© criada uma ficha forÃƒÂ§ada** Ã¢â‚¬â€ nunca se inventa uma perna de odd alta para "completar pontos".

As ligas elegÃƒÂ­veis incluem as principais (Champions, Europa, Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Primeira Liga, BrasileirÃƒÂ£o) e ainda **Conference League, J1 League (JapÃƒÂ£o), SÃƒÂ¼per Lig (Turquia) e Saudi Pro League**. DivisÃƒÂµes inferiores, femininos e ligas juvenis ficam de fora.

Todas as pernas usam apenas mercados com odds reais (`odds.realMarkets`). O motor local pode calcular probabilidades a partir do scout, mas nunca inventa um preÃƒÂ§o para preencher uma ficha.

## Motores e abas (Principal, Manual, JEV)

A interface tem trÃƒÂªs abas independentes, para comparar a eficiÃƒÂªncia de cada abordagem:

- **Principal** Ã¢â‚¬â€ motor local (faixa de probabilidade). Gera as fichas segura/moderada/ousada/maluca por horizonte, com o histÃƒÂ³rico prÃƒÂ³prio.
- **Manual** Ã¢â‚¬â€ escolhes jogos/tips jÃƒÂ¡ calculados, adicionas ao carrinho e crias a ficha (`POST /api/tickets/custom`, `engine='manual'`).
- **JEV** Ã¢â‚¬â€ o modelo de decisão recebe apenas o essencial de cada jogo (tips candidatas com probabilidade do motor local + odds reais) e escolhe a tip. As fichas sÃƒÂ£o marcadas `engine='jev'` e tÃƒÂªm histÃƒÂ³rico separado; a comparaÃƒÂ§ÃƒÂ£o Principal vs JEV aparece na prÃƒÂ³pria aba.

ConfiguraÃƒÂ§ÃƒÂ£o do JEV (TypeSafe **Decisions API** Ã¢â‚¬â€ modelo de decisÃƒÂ£o, nÃƒÂ£o chat completions):

```env
JEV_API_KEY=              # vazio usa OPENROUTER_API_KEY
JEV_MODEL=                # default typesafe/jev-1.14
JEV_DECISIONS_URL=        # opcional; default https://openrouter.ai/api/alpha/decisions
JEV_API_URL=              # alias (menos prioritÃƒÂ¡rio) para o endpoint
JEV_TIMEOUT_MS=60000
JEV_REUSE_DECISIONS=1      # 1 reutiliza decisoes guardadas; 0 forca novas chamadas
```

O JEV recebe um `state` com os jogos e, por jogo, uma pergunta `choice` cujas opcoes sao as tips candidatas (probabilidade do motor local + odd real). Devolve o mercado escolhido e a confianca, sem texto livre. As decisoes ficam persistidas na calibracao do jogo e sao reutilizadas enquanto as odds nao mudarem.

Cada geracao devolve no `message` (e nos logs `[JEV] ... custo X USD`) quantas decisoes foram novas, quantas foram reutilizadas e o custo da chamada.

## Cache (Redis opcional)

`GET /api/matches` ÃƒÂ© cacheado (25s) para a navegaÃƒÂ§ÃƒÂ£o entre abas nÃƒÂ£o recalcular ~1600 jogos. O cache usa memÃƒÂ³ria do processo por omissÃƒÂ£o; com `REDIS_URL` definido usa Redis (o `docker-compose.yml` jÃƒÂ¡ inclui o serviÃƒÂ§o `redis`). Sem o pacote/serviÃƒÂ§o Redis, cai automaticamente para memÃƒÂ³ria.

## ConfiguraÃƒÂ§ÃƒÂ£o (`.env`)

Ver `.env.example`. Chaves relevantes:

| VariÃƒÂ¡vel | Default | DescriÃƒÂ§ÃƒÂ£o |
| --- | --- | --- |
| `MYSQL_HOST` | *(vazio)* | Host do MySQL (obrigatÃƒÂ³rio em produÃƒÂ§ÃƒÂ£o) |
| `MYSQL_PORT` | `3306` | Porta do MySQL |
| `MYSQL_USER` | *(vazio)* | Utilizador do MySQL |
| `MYSQL_PASSWORD` | *(vazio)* | Password do MySQL |
| `MYSQL_DATABASE` | *(vazio)* | Nome da base de dados (deve existir) |
| `MYSQL_SSL` | *(desligado)* | `1` liga SSL na ligaÃƒÂ§ÃƒÂ£o ao MySQL |
| `BILHETERIA_DB_PATH` | `.data/bilheteria.db` | SQLite local (sÃƒÂ³ fallback de dev) |
| `TICKETS_QUOTA_DIA` | `4` | Estoque mÃƒÂ­nimo de fichas de Hoje (uma por tier) |
| `TICKETS_QUOTA_MED` | `4` | Estoque mÃƒÂ­nimo de 2 a 3 dias (uma por tier) |
| `TICKETS_QUOTA_LONGO` | `4` | Estoque mÃƒÂ­nimo de longo prazo (uma por tier) |
| `TICKETS_TARGET_SEGURA` | `3` | Alvo de odd combinada da ficha Segura |
| `TICKETS_TARGET_MODERADA` | `15` | Alvo de odd combinada da ficha Moderada |
| `TICKETS_TARGET_OUSADA` | `100` | Alvo de odd combinada da ficha Ousada |
| `TICKETS_TARGET_MALUCA` | `1000` | Alvo de odd combinada da ficha Maluca |
| `TICKETS_MAX_LEGS_SEGURA` | `8` | Teto de jogos da Segura |
| `TICKETS_MAX_LEGS_MODERADA` | `12` | Teto de jogos da Moderada |
| `TICKETS_MAX_LEGS_OUSADA` | `15` | Teto de jogos da Ousada |
| `TICKETS_MAX_LEGS_MALUCA` | `8` | Teto de jogos da Maluca |
| `TICKETS_EXPIRY_GRACE_HOURS` | `6` | TolerÃƒÂ¢ncia apÃƒÂ³s o ÃƒÂºltimo jogo antes de marcar como vencida |
| `PREMIERBET_LOGIN` | *(vazio)* | Login da conta Premier Bet |
| `PREMIERBET_PASSWORD` | *(vazio)* | Password da conta Premier Bet |
| `PREMIERBET_DRY_RUN` | `0` | `1` forÃƒÂ§a modo de teste (nÃƒÂ£o aposta) |
| `PREMIERBET_DEFAULT_STAKE` | `1000` | Valor sugerido no modal (Kz) |

## API

| MÃƒÂ©todo | Rota | DescriÃƒÂ§ÃƒÂ£o |
| --- | --- | --- |
| GET | `/api/tickets` | Lista todas as fichas (persistidas, com estado Premier Bet) |
| GET | `/api/tickets/stock` | Estoque/quotas e estado do agendador |
| POST | `/api/tickets/generate` | Gera fichas extra (`{ scope, leagues, limit }`) |
| POST | `/api/tickets/:id/upload` | Sobe a ficha para a Premier Bet (`{ stake, dryRun?, force? }`) |
| GET | `/api/premierbet/status` | ConfiguraÃƒÂ§ÃƒÂ£o visÃƒÂ­vel da Premier Bet (sem credenciais) |
| POST | `/api/matches/reset` | Limpa tudo e repÃƒÂµe o estoque |
| GET | `/api/status` | Estado do servidor (inclui `tickets`) |

## Docker

Node 24 ÃƒÂ© obrigatÃƒÂ³rio. O container lÃƒÂª a configuraÃƒÂ§ÃƒÂ£o de `.env` (`env_file`) e
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

TambÃƒÂ©m podes usar `--env-file .env` em vez de `-e` (nunca coloques segredos no
`Dockerfile` nem no repositÃƒÂ³rio). A imagem inclui Playwright + Chromium para a
automaÃƒÂ§ÃƒÂ£o da Premier Bet; `PREMIERBET_NO_SANDBOX=1` jÃƒÂ¡ vem ativo no container.

## Deploy e persistÃƒÂªncia das fichas

O `docker-compose.yml` na raiz sobe o container jÃƒÂ¡ com um volume nomeado
(`bilheteria_data`) montado em `/data` e `BILHETERIA_DB_PATH=/data/bilheteria.db`.

```bash
docker compose up -d --build     # construir e subir
docker compose logs -f           # acompanhar os logs
docker compose restart           # restart: as fichas mantÃƒÂªm-se
```

- **Restart e redeploy mantÃƒÂªm as fichas**: o volume nomeado sobrevive a
  `docker compose restart`, `up -d --build`, recriaÃƒÂ§ÃƒÂ£o do container e
  `docker compose down`.
- **Mudar `.env`** (credenciais, quotas, MySQL, etc.) exige recriar o container:

  ```bash
  docker compose up -d --force-recreate
  ```

- **`docker compose down -v` APAGA tudo**: remove o volume e, com ele, todas as
  fichas guardadas em SQLite. Usa sÃƒÂ³ quando quiseres comeÃƒÂ§ar do zero.
- **MySQL**: se preencheres `MYSQL_*` no `.env`, a persistÃƒÂªncia passa a ser o
  MySQL e o volume deixa de ser necessÃƒÂ¡rio para as fichas. O bloco opcional
  estÃƒÂ¡ comentado no `docker-compose.yml`.
- **Sem volume e sem MySQL**, o SQLite fica no sistema de ficheiros efÃƒÂ©mero do
  container: as fichas vivem sÃƒÂ³ enquanto o container existir e perdem-se no
  prÃƒÂ³ximo redeploy/recriaÃƒÂ§ÃƒÂ£o.


## Validacao de resultados

- A cada minuto, as pernas das fichas PENDENTES sao verificadas via `match/data` (prioridade).
- A cada `RESULTS_SWEEP_MINUTES` (default 15) corre uma varredura em massa: UMA chamada `matches?date=` traz `statusId` + placares de todos os jogos do dia. So se aplicam jogos terminados (`statusId 8` / `matchStatus 3`) com placar valido.
- Inclui o dia anterior (jogos que terminam depois da meia-noite).
- Antes de criar as fichas do dia (00:00), a varredura corre primeiro e as fichas sao validadas.
