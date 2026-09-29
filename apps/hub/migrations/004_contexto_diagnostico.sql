-- Lo que se envio al proveedor de IA, tal cual. Permite auditar que datos
-- salieron del Hub y reproducir un diagnostico con otro modelo o prompt.
ALTER TABLE diagnoses ADD COLUMN context jsonb;
