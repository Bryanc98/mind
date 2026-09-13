# Política de seguridad

## Estado del proyecto

M.I.N.D. está en desarrollo activo y **todavía no tiene versiones publicadas**.
Hasta la 1.0.0 no hay garantías de soporte ni de estabilidad de interfaces: la
rama `main` es la única referencia. Las versiones de desarrollo no deben
desplegarse en producción.

## Versiones soportadas

A partir de la 1.0.0 se soportan la línea menor vigente y la inmediatamente
anterior. Las correcciones de seguridad se aplican en `main` y se retroportan a
la rama `release/x.y` correspondiente, de modo que un despliegue pueda recibir la
corrección sin adoptar cambios de funcionalidad.

| Versión | Soporte |
|---|---|
| `main` (pre-1.0) | Solo desarrollo. Sin garantías |
| Línea menor vigente | Correcciones de seguridad y de defectos |
| Línea menor anterior | Solo correcciones de seguridad |
| Anteriores | Sin soporte |

El razonamiento está en
[`docs/adr/0007-versionado-y-compatibilidad.md`](docs/adr/0007-versionado-y-compatibilidad.md).

## Cómo reportar una vulnerabilidad

Usa el **reporte privado de vulnerabilidades de GitHub**: pestaña *Security* del
repositorio → *Report a vulnerability*. El canal es privado y no genera
actividad pública.

**No abras un issue público** para un problema de seguridad.

Incluye, en la medida en que aplique: la versión afectada, el sistema operativo
del nodo o del Hub, los pasos para reproducirlo y el impacto que consideras que
tiene. Un caso mínimo reproducible acelera mucho la evaluación.

Qué esperar:

*   Acuse de recibo en un plazo de 5 días laborables.
*   Una evaluación inicial, con la decisión de si se acepta como vulnerabilidad
    y su severidad, en 10 días laborables.
*   Publicación coordinada: la corrección se publica junto con el aviso, y se
    reconoce la autoría del reporte salvo que se prefiera lo contrario.

## Alcance

M.I.N.D. hace tres afirmaciones de diseño que son propiedades de seguridad
verificables leyendo el código, no opciones de configuración. **Cualquier
hallazgo que las contradiga es una vulnerabilidad:**

1.  **El agente no expone sockets de escucha.** Toda la comunicación es
    unidireccional de salida hacia el Hub.
2.  **El Hub no puede ejecutar nada en los nodos.** No existe endpoint de
    comandos, reinicio remoto, ejecución de scripts ni escritura de archivos. La
    capacidad no está deshabilitada: no está implementada.
3.  **Los datos sensibles se enmascaran antes de salir del nodo.** Credenciales,
    cadenas de conexión, tokens, correos e identificaciones personales se filtran
    antes de cualquier envío a red o a un proveedor de IA. El log original nunca
    abandona el nodo.

Entra en alcance, además: la gestión de los tokens de agente, la escalada de
privilegios desde la cuenta de servicio del agente, y las vulnerabilidades de
dependencias que sean explotables en el uso que hace el proyecto de ellas.

Queda fuera de alcance:

*   Que el agente lea logs y métricas del sistema en el que se instala: es su
    función, y se documenta que debe correr con el mínimo privilegio necesario.
*   Configuraciones deliberadamente inseguras hechas por el operador, como
    apuntar `MIND_HUB_URL` a un destino no confiable.
*   Escenarios que requieren privilegios de administrador o root previos en el
    nodo monitoreado.
*   Agotamiento de recursos causado por valores de configuración extremos
    establecidos por el propio operador.

## Diseño relacionado

*   [`docs/adr/0002-push-sin-puertos-abiertos.md`](docs/adr/0002-push-sin-puertos-abiertos.md)
    — modelo de red y ausencia de ejecución remota.
*   [`docs/adr/0003-agente-desacoplable.md`](docs/adr/0003-agente-desacoplable.md)
    — modos de operación y ubicación de las credenciales de IA.
*   [`docs/adr/0007-versionado-y-compatibilidad.md`](docs/adr/0007-versionado-y-compatibilidad.md)
    — ventana de soporte y ruta de las correcciones.
