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
  numa base de dados externa definida em `DATABASE_URL` (PostgreSQL ou Turso).
  O container não precisa de volume e não guarda estado das fichas localmente.
- **Histórico** com abas: **Ganhas**, **Perdidas**, **Vencidas/Expiradas** e
  **Em andamento**. Lista compacta (expandir por linha) com data de criação.
- **Botão "Gerar"** disponível a partir de qualquer parte do site (cabeçalho,
  hero e botão flutuante).

O agendador corre **dentro do servidor**: funciona mesmo com o site fechado.

## Base de dados

`DATABASE_URL` escolhe o motor automaticamente:

| `DATABASE_URL` | Motor |
| --- | --- |
| `postgres://user:pass@host:5432/db` | PostgreSQL (via `pg`) |
| `libsql://<db>-<org>.turso.io` + `DATABASE_AUTH_TOKEN` | Turso / libSQL |
| `https://<db>-<org>.turso.io` + `DATABASE_AUTH_TOKEN` | Turso / libSQL |
| *(vazio)* | SQLite local em `.data/bilheteria.db` (apenas desenvolvimento) |

O schema (`slips` + `meta`) é criado automaticamente no arranque. As escritas
são serializadas (write-behind) e descarregadas no shutdown.

## Requisitos

- **Node.js 24+** (o fallback local usa `node:sqlite`).
- Python com `curl_cffi` (bridge AiScore) — já configurado em `Scraping/`.

## Correr localmente

```bash
npm install
# define a BD externa em .env:
#   DATABASE_URL="postgres://..."
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
| `DATABASE_URL` | *(vazio)* | BD externa: `postgres://`, `libsql://` ou `https://` |
| `DATABASE_AUTH_TOKEN` | *(vazio)* | Token do Turso (libSQL) |
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

Node 24 é obrigatório. O container é **stateless**: a persistência fica na BD
externa configurada por `DATABASE_URL` (sem volume).

```bash
docker build -t bilheteria:latest .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL="postgres://user:pass@host:5432/bilheteria" \
  bilheteria:latest
```
