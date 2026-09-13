# Roadmap

M.I.N.D. se construye por etapas. Cada una entrega funcionalidad utilizable y
solo introduce herramientas que la etapa siguiente necesita de verdad.

| # | Entrega | Alcance técnico |
|---|---|---|
| **0** | Agente local: muestreo de CPU y RAM, máquina de estados, servicio de sistema | Configuración por entorno con validación estricta, logging NDJSON, apagado ordenado ante SIGTERM, unidad de systemd con usuario sin privilegios |
| **1** | Agente en contenedor y colector de Docker | Imagen multi-etapa sin root, límites de cgroup, estado de contenedores vía `docker inspect`, entorno de pruebas con `docker compose` |
| **2** | Hub: API de recolección, persistencia y buffer local | Fastify con validación por esquema, PostgreSQL con migraciones versionadas, autenticación por token con hash, rate limiting, cola en disco en el agente para sobrevivir cortes de red |
| **3** | Soporte de Windows Server | Servicio de Windows, lectura del Visor de eventos y de logs de IIS, cuentas de servicio y reglas de firewall |
| **4** | Integración y despliegue continuos | GitHub Actions, publicación de imágenes en GHCR, escaneo de vulnerabilidades, versionado semántico automático, proxy inverso con TLS y gestión de secretos |
| **5** | Observabilidad del propio Hub | Endpoint `/metrics` en formato Prometheus y tableros de Grafana, para que M.I.N.D. coexista con el stack estándar en vez de competir con él |
| **6** | Diagnóstico de causa raíz asistido por IA | Proveedor intercambiable (Gemini y Ollama local), deduplicación de incidentes, *cooldown* por nodo y techo de gasto diario, prompts versionados con pruebas de regresión sobre logs de referencia |
| **7** | Aprovisionamiento de flota | Despliegue del agente con Ansible: inventarios, idempotencia y secretos cifrados |

## Por qué la IA no está en la primera etapa

Es la capacidad más visible del producto y la que menos valor aporta sobre una
detección en la que todavía no se confía. Un diagnóstico automático sobre una
señal poco fiable no reduce el tiempo de resolución: multiplica el ruido y lo
hace sonar autorizado. La secuencia es primero detección confiable, después
explicación.

## Etapa actual

La etapa 0 está en curso. El agente ya valida su configuración, emite telemetría
estructurada y responde a las señales del sistema; la máquina de estados, el
colector de sistema operativo y el bucle de ejecución están en desarrollo.
