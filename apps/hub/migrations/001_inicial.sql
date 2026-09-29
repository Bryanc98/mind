-- Agentes autorizados. Solo se guarda el hash del token.
CREATE TABLE agents (
  id          bigserial PRIMARY KEY,
  node        text        NOT NULL,
  token_hash  text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
-- Un token activo por nodo: revocar y emitir uno nuevo es la rotacion.
CREATE UNIQUE INDEX agents_un_activo_por_nodo ON agents (node) WHERE revoked_at IS NULL;

-- Ultimo estado conocido de cada nodo.
CREATE TABLE nodes (
  node            text PRIMARY KEY,
  last_seen       bigint  NOT NULL,
  last_report_at  bigint  NOT NULL,
  interval_ms     integer NOT NULL,
  agent_version   text,
  host            jsonb   NOT NULL,
  targets         jsonb   NOT NULL,
  silent          boolean NOT NULL DEFAULT false
);

-- Cambios de estado: la historia de incidentes.
CREATE TABLE events (
  id           bigserial PRIMARY KEY,
  node         text   NOT NULL,
  target       text   NOT NULL,
  from_status  text   NOT NULL,
  to_status    text   NOT NULL,
  at           bigint NOT NULL,
  reason       text
);
CREATE INDEX events_por_nodo ON events (node, at DESC);

-- Serie corta de CPU y memoria para el panel. No es un almacen de series de
-- tiempo: la retencion es de horas. El historico largo es trabajo de
-- Prometheus (etapa 5).
CREATE TABLE samples (
  node  text   NOT NULL,
  at    bigint NOT NULL,
  cpu   real   NOT NULL,
  mem   real   NOT NULL
);
CREATE INDEX samples_por_instante ON samples (at);
