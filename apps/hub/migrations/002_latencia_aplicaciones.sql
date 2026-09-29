-- Serie corta de latencia por aplicacion sondeada. Misma retencion que
-- `samples`: el panel muestra la tendencia reciente, no el historico.
CREATE TABLE app_samples (
  node        text     NOT NULL,
  app         text     NOT NULL,
  at          bigint   NOT NULL,
  latency_ms  integer,
  ok          boolean  NOT NULL
);
CREATE INDEX app_samples_por_instante ON app_samples (at);
