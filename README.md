<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Bilheteria â€” motor de bilhetes

Backend sempre ativo que gera, persiste e resolve fichas (bilhetes) de apostas
a partir de jogos reais (AiScore + odds de mercado).

## Fichas automÃ¡ticas e persistentes

- **Fichas do dia**: todos os dias Ã s **00:00 de Angola** (`Africa/Luanda`), o
  agendador cria automaticamente a fornada de fichas de "Hoje" (default: 4).
- **Estoque por horizonte**: mantÃ©m um mÃ­nimo de fichas pendentes â€”
  Hoje = 4, 2 a 3 dias = 4, Longo prazo = 4 (configurÃ¡vel em `.env`).
  Sempre que uma ficha cai (ganha/perde/expira), o agendador **repÃµe** o estoque.
- **SÃ³ odds reais**: jogos sem odds 1X2 do fornecedor nÃ£o entram no mercado.
  NÃ£o hÃ¡ preenchimento com odds fixas "inventadas"; mercados derivados
  (dupla chance, DNB, etc.) ficam marcados e nÃ£o sÃ£o usados para montar fichas.
- **PersistÃªncia na base de dados**: as fichas vivem numa base de dados **MySQL**
  configurada por variÃ¡veis de ambiente (`MYSQL_HOST`, `MYSQL_PORT`,
  `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`) ou, quando nÃ£o hÃ¡ MySQL,
  em **SQLite** no caminho `BILHETERIA_DB_PATH`. No Docker o default Ã©
  `/data/bilheteria.db`, dentro do volume nomeado que preserva as fichas.
- **HistÃ³rico** com abas: **Ganhas**, **Perdidas**, **Vencidas/Expiradas** e
  **Em andamento**. Lista compacta (expandir por linha) com data de criaÃ§Ã£o.
- **BotÃ£o "Gerar"** disponÃ­vel a partir de qualquer parte do site (cabeÃ§alho,
  hero e botÃ£o flutuante).
- **Subir para a Premier Bet**: cada ficha pendente tem um botÃ£o **Subir** que
  entra em `premierbet.co.ao`, localiza os jogos, preenche as tips, define o
  valor da aposta e coloca a ficha no ar. O valor Ã© pedido num modal (Kz).

O agendador corre **dentro do servidor**: funciona mesmo com o site fechado.

## Base de dados (MySQL)

Toda a configuraÃ§Ã£o vem da env:

| VariÃ¡vel | Exemplo | ObrigatÃ³ria |
| --- | --- | --- |
| `MYSQL_HOST` | `127.0.0.1` | sim |
| `MYSQL_PORT` | `3306` | nÃ£o (default `3306`) |
| `MYSQL_USER` | `bilheteria` | sim |
| `MYSQL_PASSWORD` | `segredo` | nÃ£o (pode ser vazia) |
| `MYSQL_DATABASE` | `bilheteria` | sim |
| `MYSQL_SSL` | `1` | nÃ£o (default desligado) |

O schema (`slips` + `meta` + `slip_uploads`) Ã© criado automaticamente no
arranque, na base de dados indicada em `MYSQL_DATABASE` (tem de existir). As
escritas sÃ£o serializadas (write-behind) e descarregadas no shutdown.

Se `MYSQL_HOST`, `MYSQL_USER` e `MYSQL_DATABASE` estiverem vazios, o servidor
usa SQLite local em `.data/bilheteria.db` apenas para desenvolvimento. Se apenas
parte deles estiver preenchida, o arranque falha com uma mensagem a indicar o
que falta.

## Subir fichas para a Premier Bet

O botÃ£o **Subir** (em cada ficha pendente, no cartÃ£o ou no histÃ³rico) abre um
modal para definir o **valor da aposta em Kwanzas (AOA)** e, opcionalmente,
testar o boletim sem apostar.

Ao confirmar, o servidor:

1. faz login em `https://www.premierbet.co.ao/` com as credenciais da env;
2. localiza cada jogo da ficha na API da Premier Bet (nomes + data) e lÃª os
   mercados/odds atuais;
3. injeta as seleÃ§Ãµes no boletim, define o valor e coloca a aposta;
4. guarda o resultado em `slip_uploads` (estado, valor, ID da aposta).

O browser corre no servidor (Playwright/Chromium), por isso o site pode estar
fechado no teu computador. A operaÃ§Ã£o pode demorar 1â€“3 minutos.

### Credenciais e seguranÃ§a

| VariÃ¡vel | Default | DescriÃ§Ã£o |
| --- | --- | --- |
| `PREMIERBET_LOGIN` | *(vazio)* | Telefone (`244...`), utilizador ou email da conta |
| `PREMIERBET_PASSWORD` | *(vazio)* | Palavra-passe da conta Premier Bet |
| `PREMIERBET_DRY_RUN` | `0` | `1` forÃ§a o modo de teste em todos os pedidos (nÃ£o aposta) |
| `PREMIERBET_DEFAULT_STAKE` | `1000` | Valor sugerido no modal (Kz) |
| `PREMIERBET_MIN_STAKE` | `1` | Valor mÃ­nimo aceite pela API (Kz) |
| `PREMIERBET_MAX_STAKE` | *(sem limite)* | Valor mÃ¡ximo aceite pela API (Kz) |
| `PREMIERBET_TIMEOUT_MS` | `300000` | Tempo mÃ¡ximo da automaÃ§Ã£o (5 min) |
| `PREMIERBET_HEADFUL` | `0` | `1` mostra o browser (debug local) |
| `PREMIERBET_NO_SANDBOX` | `0` | `1` adiciona `--no-sandbox` ao Chromium (contentores) |
| `PREMIERBET_PYTHON` | `AISCORE_PYTHON` | Python com `playwright` + `curl_cffi` |

As credenciais **nunca** sÃ£o escritas em ficheiros nem em argumentos de linha de
comando: seguem apenas no ambiente do processo Python.

> **Aviso:** a aplicaÃ§Ã£o nÃ£o tem autenticaÃ§Ã£o prÃ³pria e o botÃ£o **Subir** coloca
> **dinheiro real**. NÃ£o exponhas a porta do servidor Ã  internet sem um proxy ou
> uma rede privada com autenticaÃ§Ã£o.

**ProteÃ§Ã£o contra apostas duplicadas:** uma ficha jÃ¡ colocada fica marcada como
**No ar** e nÃ£o pode ser reenviada sem confirmaÃ§Ã£o explÃ­cita. Se a Premier Bet
nÃ£o confirmar a colocaÃ§Ã£o, o estado fica **por confirmar** e o sistema nÃ£o repete
a aposta automaticamente â€” verifica primeiro as apostas abertas na conta. Se o
servidor reiniciar a meio de uma submissÃ£o, o registo **em curso** Ã© convertido
em **por confirmar** no arranque seguinte (nunca Ã© reenviado sozinho).

### InstalaÃ§Ã£o local do browser

```bash
pip install playwright
python -m playwright install chromium
```

Em Docker a imagem jÃ¡ inclui Playwright + Chromium (a imagem fica maior).

## Requisitos

- **Node.js 24+** (o fallback local usa `node:sqlite`).
- **MySQL 5.7+ / 8.0+ / MariaDB 10.5+** (em produÃ§Ã£o).
- Python com `curl_cffi` (bridge AiScore) e `playwright` + Chromium
  (automaÃ§Ã£o Premier Bet).

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
npm start          # servidor de produÃ§Ã£o local
```

Para garantir que o servidor fica **sempre ativo** (reinicia se cair):

```bash
npm run start:always      # PowerShell (Windows)
npm run start:always:bat  # Batch (Windows)
```

Ou com um gestor de processos (produÃ§Ã£o):

```bash
npx pm2 start "npm start" --name bilheteria
```

## Tiers de fichas

O motor gera quatro categorias por horizonte, com uma vaga reservada para cada uma:

| Tier | Alvo | ConstruÃ§Ã£o |
| --- | --- | --- |
| **Segura** | 3x | Tips de probabilidade calibrada alta; o nÃºmero de jogos Ã© o necessÃ¡rio para chegar ao alvo |
| **Moderada** | 15x | Tips de risco moderado; mais jogos e odds individuais controladas, sem pernas artificiais |
| **Ousada** | 100x | Tips de odds controladas; o alvo Ã© alcanÃ§ado acumulando mais jogos, nÃ£o inventando odds altas |
| **Maluca** | 1000x | 4â€“8 jogos de odd alta, usando a tip alternativa de odd alta calculada pelo motor para cada jogo |

O motor calcula primeiro uma tip para **todos os jogos com odds reais** do horizonte e, para cada jogo, tambÃ©m uma tip alternativa de odd alta (outro mercado real do mesmo jogo). A ficha Ã© apenas uma seleÃ§Ã£o dessas tips: ordena por probabilidade, acrescenta jogos atÃ© a odd combinada atingir o alvo e pÃ¡ra. Se nÃ£o houver tips suficientes para o alvo, **nÃ£o Ã© criada uma ficha forÃ§ada** â€” nunca se inventa uma perna de odd alta para "completar pontos".

As ligas elegÃ­veis incluem as principais (Champions, Europa, Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Primeira Liga, BrasileirÃ£o) e ainda **Conference League, J1 League (JapÃ£o), SÃ¼per Lig (Turquia) e Saudi Pro League**. DivisÃµes inferiores, femininos e ligas juvenis ficam de fora.

Todas as pernas usam apenas mercados com odds reais (`odds.realMarkets`). O motor local pode calcular probabilidades a partir do scout, mas nunca inventa um preÃ§o para preencher uma ficha.

## ConfiguraÃ§Ã£o (`.env`)

Ver `.env.example`. Chaves relevantes:

| VariÃ¡vel | Default | DescriÃ§Ã£o |
| --- | --- | --- |
| `MYSQL_HOST` | *(vazio)* | Host do MySQL (obrigatÃ³rio em produÃ§Ã£o) |
| `MYSQL_PORT` | `3306` | Porta do MySQL |
| `MYSQL_USER` | *(vazio)* | Utilizador do MySQL |
| `MYSQL_PASSWORD` | *(vazio)* | Password do MySQL |
| `MYSQL_DATABASE` | *(vazio)* | Nome da base de dados (deve existir) |
| `MYSQL_SSL` | *(desligado)* | `1` liga SSL na ligaÃ§Ã£o ao MySQL |
| `BILHETERIA_DB_PATH` | `.data/bilheteria.db` | SQLite local (sÃ³ fallback de dev) |
| `TICKETS_QUOTA_DIA` | `4` | Estoque mÃ­nimo de fichas de Hoje (uma por tier) |
| `TICKETS_QUOTA_MED` | `4` | Estoque mÃ­nimo de 2 a 3 dias (uma por tier) |
| `TICKETS_QUOTA_LONGO` | `4` | Estoque mÃ­nimo de longo prazo (uma por tier) |
| `TICKETS_TARGET_SEGURA` | `3` | Alvo de odd combinada da ficha Segura |
| `TICKETS_TARGET_MODERADA` | `15` | Alvo de odd combinada da ficha Moderada |
| `TICKETS_TARGET_OUSADA` | `100` | Alvo de odd combinada da ficha Ousada |
| `TICKETS_TARGET_MALUCA` | `1000` | Alvo de odd combinada da ficha Maluca |
| `TICKETS_MAX_LEGS_SEGURA` | `8` | Teto de jogos da Segura |
| `TICKETS_MAX_LEGS_MODERADA` | `12` | Teto de jogos da Moderada |
| `TICKETS_MAX_LEGS_OUSADA` | `15` | Teto de jogos da Ousada |
| `TICKETS_MAX_LEGS_MALUCA` | `8` | Teto de jogos da Maluca |
| `TICKETS_EXPIRY_GRACE_HOURS` | `6` | TolerÃ¢ncia apÃ³s o Ãºltimo jogo antes de marcar como vencida |
| `PREMIERBET_LOGIN` | *(vazio)* | Login da conta Premier Bet |
| `PREMIERBET_PASSWORD` | *(vazio)* | Password da conta Premier Bet |
| `PREMIERBET_DRY_RUN` | `0` | `1` forÃ§a modo de teste (nÃ£o aposta) |
| `PREMIERBET_DEFAULT_STAKE` | `1000` | Valor sugerido no modal (Kz) |

## API

| MÃ©todo | Rota | DescriÃ§Ã£o |
| --- | --- | --- |
| GET | `/api/tickets` | Lista todas as fichas (persistidas, com estado Premier Bet) |
| GET | `/api/tickets/stock` | Estoque/quotas e estado do agendador |
| POST | `/api/tickets/generate` | Gera fichas extra (`{ scope, leagues, limit }`) |
| POST | `/api/tickets/:id/upload` | Sobe a ficha para a Premier Bet (`{ stake, dryRun?, force? }`) |
| GET | `/api/premierbet/status` | ConfiguraÃ§Ã£o visÃ­vel da Premier Bet (sem credenciais) |
| POST | `/api/matches/reset` | Limpa tudo e repÃµe o estoque |
| GET | `/api/status` | Estado do servidor (inclui `tickets`) |

## Docker

Node 24 Ã© obrigatÃ³rio. O container lÃª a configuraÃ§Ã£o de `.env` (`env_file`) e
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

TambÃ©m podes usar `--env-file .env` em vez de `-e` (nunca coloques segredos no
`Dockerfile` nem no repositÃ³rio). A imagem inclui Playwright + Chromium para a
automaÃ§Ã£o da Premier Bet; `PREMIERBET_NO_SANDBOX=1` jÃ¡ vem ativo no container.

## Deploy e persistÃªncia das fichas

O `docker-compose.yml` na raiz sobe o container jÃ¡ com um volume nomeado
(`bilheteria_data`) montado em `/data` e `BILHETERIA_DB_PATH=/data/bilheteria.db`.

```bash
docker compose up -d --build     # construir e subir
docker compose logs -f           # acompanhar os logs
docker compose restart           # restart: as fichas mantÃªm-se
```

- **Restart e redeploy mantÃªm as fichas**: o volume nomeado sobrevive a
  `docker compose restart`, `up -d --build`, recriaÃ§Ã£o do container e
  `docker compose down`.
- **Mudar `.env`** (credenciais, quotas, MySQL, etc.) exige recriar o container:

  ```bash
  docker compose up -d --force-recreate
  ```

- **`docker compose down -v` APAGA tudo**: remove o volume e, com ele, todas as
  fichas guardadas em SQLite. Usa sÃ³ quando quiseres comeÃ§ar do zero.
- **MySQL**: se preencheres `MYSQL_*` no `.env`, a persistÃªncia passa a ser o
  MySQL e o volume deixa de ser necessÃ¡rio para as fichas. O bloco opcional
  estÃ¡ comentado no `docker-compose.yml`.
- **Sem volume e sem MySQL**, o SQLite fica no sistema de ficheiros efÃ©mero do
  container: as fichas vivem sÃ³ enquanto o container existir e perdem-se no
  prÃ³ximo redeploy/recriaÃ§Ã£o.
