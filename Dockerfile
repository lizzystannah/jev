# Bilheteria — motor de bilhetes (Node 20 + bridge Python AiScore)
#
# Build (a partir da raiz deste projeto):
#   docker build -t bilheteria:latest .
# Run (nunca montar o .env local com chaves — passar por ambiente):
#   docker run --rm -p 3000:3000 \
#     -e ODDS_API_KEY="" \
#     -e GEMINI_API_KEY="" \
#     bilheteria:latest
# Persistir caches entre restarts (opcional):
#   docker run --rm -p 3000:3000 -v bilheteria-cache:/app/.data ... (ver nota)
#
# Notas:
# - O bridge Python (Scraping/aiscore_bridge.py) usa curl_cffi para passar
#   no Cloudflare do AiScore; as deps Python vivem em Scraping/ (autocontido).
# - O servidor escreve caches em disco (.aiscore_context_cache.json e
#   .odds_api_cache.json na raiz). Sem volume, o cache morre com o contentor.
# - NODE_ENV=production serve o frontend (dist/) + API na mesma porta.

FROM node:20-bookworm-slim

# Python 3 (bridge AiScore) + dependência nativa do curl_cffi (wheels linux).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && pip install --no-cache-dir --break-system-packages "curl_cffi>=0.7"

WORKDIR /app

# Variáveis de runtime (chaves SEMPRE via -e / --env-file, nunca no build).
ENV NODE_ENV=production \
    PORT=3000 \
    PYTHONUTF8=1 \
    AISCORE_PYTHON=python3

# Dependências Node primeiro (melhor cache de layers).
COPY package.json package-lock.json ./
# tsx é devDependency mas o `npm start` precisa dele em runtime.
RUN npm ci --include=dev

COPY . .

RUN npm run build

# Correr como não-root; o servidor escreve caches em /app.
RUN useradd -m -u 10001 appuser \
  && chown -R appuser:appuser /app
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
