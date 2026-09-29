-- Log enmascarado que el agente adjunta a un evento de falla.
ALTER TABLE events ADD COLUMN logs text;

-- Diagnosticos de causa raiz. Uno por incidente: un incidente agrupa las
-- caidas que ocurren juntas, aunque sean de servidores distintos.
CREATE TABLE diagnoses (
  id              bigserial PRIMARY KEY,
  created_at      bigint  NOT NULL,
  status          text    NOT NULL,        -- pendiente | listo | error
  provider        text    NOT NULL,
  model           text    NOT NULL,
  prompt_version  text    NOT NULL,
  -- Objetivos caidos que dispararon el diagnostico: [{node, target, at, reason}]
  triggers        jsonb   NOT NULL,
  result          jsonb,
  error           text,
  latency_ms      integer
);
CREATE INDEX diagnoses_recientes ON diagnoses (created_at DESC);
