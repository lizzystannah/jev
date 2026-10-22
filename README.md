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
- **Persistência**: todas as fichas vivem numa base de dados SQLite
  (`node:sqlite`) em `.data/bilheteria.db`. Sobrevivem a reinícios do servidor
  até serem resolvidas ou expirarem.
- **Histórico** com abas: **Ganhas**, **Perdidas**, **Vencidas/Expiradas** e
  **Em andamento**. Lista compacta (expandir por linha) com data de criação.
- **Botão "Gerar"** disponível a partir de qualquer parte do site (cabeçalho,
  hero e botão flutuante).

O agendador corre **dentro do servidor**: funciona mesmo com o site fechado.

## Requisitos

- **Node.js 24+** (a persistência usa o módulo nativo `node:sqlite`).
- Python com `curl_cffi` (bridge AiScore) — já configurado em `Scraping/`.

## Correr localmente

```bash
npm install
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

Ver `.env.example`. Chaves relevantes do agendador:

| Variável | Default | Descrição |
| --- | --- | --- |
| `BILHETERIA_DB_PATH` | `.data/bilheteria.db` | Caminho da base SQLite |
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

Node 24 é obrigatório. Monte um volume para persistir fichas e caches:

```bash
docker build -t bilheteria:latest .
docker run --rm -p 3000:3000 -v bilheteria-data:/app/.data bilheteria:latest
```
