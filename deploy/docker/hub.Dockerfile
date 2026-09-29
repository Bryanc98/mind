# syntax=docker/dockerfile:1
# Imagen del M.I.N.D. hub. Se construye desde la raiz del repositorio:
#   docker build -f deploy/docker/hub.Dockerfile -t mind-hub .

# --- Etapa de construccion: pnpm y el lockfile solo existen aqui. -------------
FROM node:24.20.0-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps ./apps
# Solo dependencias de produccion del paquete y de lo que importa.
RUN CI=true pnpm install --frozen-lockfile --prod --filter "@mind/hub..."

# --- Imagen final: sin gestor de paquetes, sin compiladores, sin root. --------
FROM node:24.20.0-alpine
ENV NODE_ENV=production
WORKDIR /opt/mind
COPY --from=build /app ./
# npm y corepack no hacen falta en ejecucion: menos binarios, menos superficie.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/hub/src/main.js"]
