# syntax=docker/dockerfile:1
# Imagen del M.I.N.D. agent. Se construye desde la raiz del repositorio:
#   docker build -f deploy/docker/agent.Dockerfile -t mind-agent .

# --- Etapa de construccion: pnpm y el lockfile solo existen aqui. -------------
FROM node:24.20.0-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps ./apps
# Solo dependencias de produccion del paquete y de lo que importa.
RUN CI=true pnpm install --frozen-lockfile --prod --filter "@mind/agent..."

# --- Imagen final: sin gestor de paquetes, sin compiladores, sin root. --------
FROM node:24.20.0-alpine
ENV NODE_ENV=production
WORKDIR /opt/mind
COPY --from=build /app ./
# npm y corepack no hacen falta en ejecucion: menos binarios, menos superficie.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# Directorio de la cola en disco: el unico lugar donde el agente escribe.
RUN mkdir -p /var/lib/mind && chown node:node /var/lib/mind
ENV MIND_BUFFER_DIR=/var/lib/mind
VOLUME /var/lib/mind
USER node
# Sin EXPOSE: el agente no escucha en ningun puerto (ADR 0002).
CMD ["node", "apps/agent/src/main.js"]
