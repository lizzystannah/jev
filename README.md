<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Bilheteria — motor de bilhetes

Backend sempre ativo que gera, persiste e resolve fichas (bilhetes) de apostas
a partir de jogos reais (AiScore + odds de mercado).

## Fichas automáticas e persistentes

- **Fichas do dia**: todos os dias às **00:00 de Angola** (`Africa/Luanda`), o
  agendador cria automaticamente a fornada de fichas de "Hoje" (default: 3).
- **Estoque por horizonte**: mantém um mínimo de fichas pendentes —
  Hoje = 3, 2 a 3 dias = 3, Longo prazo = 2 (configurável em `.env`).
  Sempre que uma ficha cai (ganha/perde/expira), o agendador **repõe** o estoque.
- **Persistência na base de dados**: todas as fichas vivem **exclusivamente**
  numa base de dados **MySQL** configurada por variáveis de ambiente
  (`MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`,
  `MYSQL_DATABASE`). O container não precisa de volume e não guarda estado
  das fichas localmente.
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
| `TICKETS_QUOTA_DIA` | `3` | Estoque mínimo de fichas de Hoje |
| `TICKETS_QUOTA_MED` | `3` | Estoque mínimo de 2 a 3 dias |
| `TICKETS_QUOTA_LONGO` | `2` | Estoque mínimo de longo prazo |
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

Node 24 é obrigatório. O container é **stateless**: a persistência fica no
MySQL configurado por variáveis de ambiente (sem volume).

```bash
docker build -t bilheteria:latest .
docker run --rm -p 3000:3000 \
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
