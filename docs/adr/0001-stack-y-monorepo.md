# ADR 0001 — Node.js 24 LTS + Fastify + PostgreSQL + Vue 3 en un monorepo pnpm

*   **Estado:** aceptado
*   **Fecha:** 2026-09-07

## Contexto

El documento de arquitectura original dejaba abiertas varias alternativas: "Node.js
(Express) **o** .NET 8", "VueJS **o** Angular", "PostgreSQL **o** SQL Server". Una
ambigüedad así en un documento de diseño se paga después: cada archivo nuevo obliga a
volver a decidir, y el proyecto termina con dos estilos a medio hacer.

Restricciones reales:

*   El agente tiene que correr en Linux y en Windows Server con el **mismo** código.
*   Footprint objetivo del agente: < 65 MB de RAM.
*   El equipo que lo mantiene desarrolla principalmente en JavaScript/Node.
*   El núcleo es open source; la versión institucional debe poder cambiar la
    persistencia sin tocar el núcleo.

## Decisión

*   **Runtime: Node.js 24 LTS**, fijado en `.node-version` (24.20.0). Trae `fetch`
    nativo y `node:test` integrado, lo que permite que el agente no tenga **ninguna**
    dependencia de producción en la etapa 0.

    Se elige 24 y no 22 por el calendario de soporte, verificado el 2026-09-07
    contra el `schedule.json` oficial de Node: **la 20 está EOL desde el
    2026-04-30**, la 22 muere el 2027-04-30 y la 24 el 2028-04-30. Un agente que
    se despliega en decenas de servidores no se ancla a un runtime con siete
    meses de vida: cada actualización mayor en una flota es un proyecto.

    El piso en `package.json` es `>=22.11.0`, no 24, a propósito: si un servidor
    heredado ya tiene la 22 instalada, el agente corre igual. Se fija arriba lo
    que se desarrolla, se declara abajo lo que se soporta.

    Revisar en octubre de 2026, cuando la 26 pase a LTS y la 24 entre en
    mantenimiento.
*   **API del Hub: Fastify.** Sobre Express porque valida entrada por esquema JSON de
    forma nativa (en un endpoint que recibe datos de N agentes eso es control de
    seguridad, no comodidad), tiene mejor rendimiento y Express está en mantenimiento
    mínimo.
*   **Base de datos: PostgreSQL.** El núcleo abierto habla Postgres; SQL Server entra
    en la versión institucional como plugin de persistencia (ADR 0005).
*   **Dashboard: Vue 3.** Superficie de API menor que Angular para un panel de
    este tamaño, y menor costo de incorporación para quien contribuya.
*   **Monorepo: pnpm workspaces.** Sin herramientas de build adicionales (ni Nx ni
    Turborepo) mientras no haya dolor real que las justifique.

## Alternativas descartadas

*   **.NET 8 Minimal API para el Hub.** Rendimiento excelente y encaja bien en una
    institución con infraestructura Microsoft. Descartado porque partir el proyecto
    en dos lenguajes duplica la cadena de herramientas, el CI y la carga cognitiva
    de mantenimiento. Un solo lenguaje en agente, Hub y panel es una ventaja
    concreta para un equipo pequeño. Si el Hub llegara a necesitar integración
    profunda con Active Directory o SQL Server, se reconsidera **solo para el
    Hub**; el agente se queda en Node por portabilidad.
*   **Go o Rust para el agente.** Un único binario estático sin runtime es
    objetivamente la mejor opción técnica para un agente: menor footprint, sin
    dependencia de Node instalado en el servidor. Descartado para mantener un solo
    lenguaje en todo el sistema y no duplicar la cadena de herramientas.
    **Es una deuda técnica reconocida**, no un descuido: si el footprint en
    producción se vuelve un problema, el agente es el componente más pequeño y el
    candidato natural a reescribirse.
*   **Nx / Turborepo.** Resuelven caché de builds y grafos de dependencias que este
    proyecto todavía no tiene. Añadirlas ahora es asumir el costo de su
    configuración sin obtener ningún beneficio.
*   **Un repositorio por paquete.** Descartado: cambiar el contrato entre agente y
    Hub tocaría tres repositorios y tres PRs coordinados.

## Consecuencias

**A favor:** una sola cadena de herramientas; el agente sin dependencias de
producción en etapa 0 (superficie de ataque mínima y cero riesgo de cadena de
suministro); tests sin instalar nada.

**En contra, y hay que asumirlo:**

*   **Node en cada servidor monitoreado.** Un runtime de ~50 MB y un vector de
    actualizaciones de seguridad más en cada nodo. Un binario de Go no tendría eso.
*   **El footprint de 65 MB va a estar apretado.** Node arranca en ~40 MB de RSS
    antes de ejecutar nada nuestro. Hay que medirlo desde la etapa 1, no al final.
*   **pnpm workspaces sin `node_modules` plano** rompe herramientas que asumen la
    estructura clásica de npm. Aparecerá en la etapa 4, con el CI.
*   **Vue 3 es la elección menos defendida** de las cuatro. Se decidió por tamaño del
    problema, no por análisis profundo. Si el equipo institucional ya domina Angular,
    esta decisión es la primera que hay que revisar.
