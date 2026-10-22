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

O schema (`slips` + `meta`) é criado automaticamente no arranque, na base de
dados indicada em `MYSQL_DATABASE` (tem de existir). As escritas são
serializadas (write-behind) e descarregadas no shutdown.

Se `MYSQL_HOST`, `MYSQL_USER` e `MYSQL_DATABASE` estiverem vazios, o servidor
usa SQLite local em `.data/bilheteria.db` apenas para desenvolvimento. Se apenas
parte deles estiver preenchida, o arranque falha com uma mensagem a indicar o
que falta.

## Requisitos

- **Node.js 24+** (o fallback local usa `node:sqlite`).
- **MySQL 5.7+ / 8.0+ / MariaDB 10.5+** (em produção).
- Python com `curl_cffi` (bridge AiScore) — já configurado em `Scraping/`.

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

## API

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/api/tickets` | Lista todas as fichas (persistidas) |
| GET | `/api/tickets/stock` | Estoque/quotas e estado do agendador |
| POST | `/api/tickets/generate` | Gera fichas extra (`{ scope, leagues, limit }`) |
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
  bilheteria:latest
```
