# Bilheteria — motor de bilhetes (Node 24 + bridge Python AiScore)
#
# Node 24: módulo nativo node:sqlite (usado apenas no fallback local de dev).
#
# Build (a partir da raiz deste projeto):
#   docker build -t bilheteria:latest .
# Run (nunca montar o .env local com chaves — passar por ambiente):
#   docker run --rm -p 3000:3000 \
#     -e MYSQL_HOST="host-do-mysql" \
#     -e MYSQL_PORT="3306" \
#     -e MYSQL_USER="bilheteria" \
#     -e MYSQL_PASSWORD="segredo" \
#     -e MYSQL_DATABASE="bilheteria" \
#     -e PREMIERBET_LOGIN="244..." \
#     -e PREMIERBET_PASSWORD="segredo" \
#     -e ODDS_API_KEY="" \
#     -e GEMINI_API_KEY="" \
#     bilheteria:latest
#
# Persistência: fica EXCLUSIVAMENTE na base de dados MySQL configurada pelas
# variáveis MYSQL_*. O container não precisa de volume e não guarda estado das
# fichas localmente.
#
# Notas:
# - O bridge Python (Scraping/aiscore_bridge.py) usa curl_cffi para passar
#   no Cloudflare do AiScore; as deps Python vivem em Scraping/ (autocontido).
# - A automação da Premier Bet usa Playwright + Chromium (instalados abaixo em
#   /ms-playwright). A imagem fica maior (~400 MB extra), mas o browser corre
#   dentro do container sem depender do computador do utilizador.
# - Caches de odds/scout são descartáveis e podem ser regenerados no arranque.
# - NODE_ENV=production serve o frontend (dist/) + API na mesma porta.

FROM node:24-bookworm-slim

# Python 3 (bridges AiScore/Premier Bet) + curl_cffi + Playwright.
# PLAYWRIGHT_BROWSERS_PATH fixa o Chromium fora da home do root para o appuser
# conseguir lê-lo em runtime.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && pip install --no-cache-dir --break-system-packages \
       "curl_cffi>=0.7" "playwright>=1.49"

RUN playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Variáveis de runtime (chaves SEMPRE via -e / --env-file, nunca no build).
ENV NODE_ENV=production \
    PORT=3000 \
    PYTHONUTF8=1 \
    AISCORE_PYTHON=python3 \
    PREMIERBET_NO_SANDBOX=1

# Dependências Node primeiro (melhor cache de layers).
COPY package.json package-lock.json ./
# tsx é devDependency mas o `npm start` precisa dele em runtime.
RUN npm ci --include=dev

COPY . .

RUN npm run build

# Correr como não-root; o servidor escreve caches em /app.
RUN useradd -m -u 10001 appuser \
  && chown -R appuser:appuser /app
# /data é o ponto de montagem do volume que persiste as fichas (SQLite).
RUN mkdir -p /data && chown appuser:appuser /data
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
