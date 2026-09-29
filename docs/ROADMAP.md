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

**Etapas 0 y 1 completas; núcleo de la etapa 2 funcional.**

*   **Etapa 0.** Configuración con validación estricta, máquina de estados de
    umbrales asimétricos, telemetría NDJSON, apagado ordenado y unidad de
    systemd endurecida ([`deploy/systemd/`](../deploy/systemd/mind-agent.service)).
*   **Etapa 1.** Imágenes multi-etapa sin root, métricas contra los límites de
    cgroup v2, colector de contenedores sobre la Engine API detrás de un proxy
    de solo lectura (estado, memoria, reinicios y su causa), sondeo de
    aplicaciones por HTTP (código y latencia), y entorno completo con
    `docker compose` que simula varios servidores con fallas reales.
*   **Etapa 2.** Hub en Fastify con validación por esquema, PostgreSQL con
    migraciones versionadas, tokens por nodo guardados como hash, rate limiting
    por token, *dead man's switch*, cola en disco en el agente y panel de flota.

*   **Etapa 6, adelantada en su núcleo.** Con la detección ya probada contra
    fallas reales, el diagnóstico por IA dejó de ser prematuro: proveedor
    intercambiable (Gemini y Ollama) con cadena de respaldo, logs enmascarados
    en el agente y otra vez en el Hub, agrupación de caídas en cascada en un
    solo incidente, *cooldown*, techo diario, prompt versionado y pruebas de
    referencia sobre incidentes reales.

Pendiente de la etapa 2: notificaciones salientes (SMTP) y la vista histórica
de incidentes. Pendiente de la etapa 6: diagnóstico en modo standalone y
seguimiento de costo por proveedor.
