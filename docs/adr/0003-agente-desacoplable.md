# ADR 0003 — El agente funciona sin Hub, y la presencia de `MIND_HUB_URL` es lo único que lo decide

*   **Estado:** aceptado
*   **Fecha:** 2026-09-07

## Contexto

Hay dos escenarios de uso que parecen exigir dos productos distintos:

1.  Una institución con 40 servidores que necesita un panel central, históricos y
    alertas coordinadas.
2.  Un servidor aislado —un VPS personal, una máquina en una red sin salida al Hub—
    donde montar un Hub para un solo nodo es absurdo.

Si se construyen como dos productos, hay dos bases de código que divergen. Si se
construye solo el primero, el segundo caso queda sin cubrir y el proyecto pierde a
todo el público open source que probaría la herramienta en su propio servidor antes
de proponerla en su trabajo.

## Decisión

Un solo agente con dos modos, y **una sola variable los distingue**:

*   `MIND_HUB_URL` **ausente** → modo `standalone`. El agente sanitiza, consulta al
    proveedor de IA y notifica por SMTP, todo local.
*   `MIND_HUB_URL` **presente** → modo `hub`. El agente solo recolecta y hace `POST`.
    El Hub asume la IA y las notificaciones.

La detección y la máquina de estados son **idénticas** en ambos modos. Lo único que
cambia es a dónde va el evento cuando `changed === true`.

Se decidió que fuera la *presencia* de la URL y no un `MIND_MODE=standalone|hub`
explícito, porque un modo explícito permite estados contradictorios
(`MIND_MODE=hub` sin URL) que habría que validar y reportar. Un dato que puede
contradecir a otro es un dato de más.

## Alternativas descartadas

*   **`MIND_MODE` explícito.** Más legible en el `.env`, pero introduce dos fuentes
    de verdad que pueden contradecirse. Misma lógica que en `loop.js`: preferimos
    hacer inexpresable el estado inválido antes que validarlo.
*   **Dos binarios (`mind-agent-standalone` y `mind-agent-collector`).** Descartado:
    dos artefactos que construir, firmar, publicar y mantener, y la garantía de que
    uno de los dos va a quedar atrasado.
*   **Modo standalone como plugin opcional.** Descartado: el modo standalone es
    precisamente el que va a usar cualquiera que pruebe el proyecto por curiosidad.
    Poner la puerta de entrada detrás de una instalación extra es un error de
    adopción.

## Consecuencias

**A favor:** una sola base de código; el modo standalone sirve de campo de pruebas
para el agente sin necesidad de levantar la infraestructura completa; el proyecto
open source es útil por sí solo, sin el Hub institucional.

**En contra:**

*   **El agente carga código que en modo hub no usa nunca** (cliente de IA,
    notificador SMTP): más peso y más superficie de ataque de la necesaria en el modo
    en que se desplegará en 40 servidores. La mitigación es carga diferida
    (`await import()` solo en modo standalone), y hay que implementarla en la etapa 6
    o el footprint de 65 MB no se cumple.
*   **Duplicación de la lógica de notificación**: en el agente para standalone y en
    el Hub para el modo centralizado. Hay que extraerla a un paquete compartido desde
    el principio, o serán dos implementaciones que se desincronizan.
*   **Dos rutas de código que hay que probar en CI.** La tentación va a ser probar
    solo el modo hub, que es el que se despliega, y descubrir el standalone roto
    cuando alguien abra un issue.
*   **Las claves de la IA quedan en cada nodo** en modo standalone. Es
    inevitablemente peor que centralizarlas en el Hub, y es una razón más para que la
    versión institucional use exclusivamente el modo hub.
