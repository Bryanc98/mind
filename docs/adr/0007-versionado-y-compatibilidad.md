# ADR 0007 — Versionado semántico, tolerancia a versiones mixtas y ruta de actualización

*   **Estado:** aceptado
*   **Fecha:** 2026-09-08

## Contexto

El [ADR 0005](0005-licencia-y-split-oss-interno.md) establece que los despliegues
privados consumen el núcleo público como dependencia versionada en lugar de
forkearlo. Eso resuelve la estructura, pero deja abierta la mecánica: cómo llega
una corrección publicada en el núcleo a una flota ya instalada.

Tres restricciones operativas condicionan la respuesta:

1.  **Los despliegues no son instantáneos.** Actualizar el Hub y decenas de
    agentes en el mismo instante no es posible. Durante la ventana de despliegue
    coexisten agentes y Hub en versiones distintas.
2.  **Las organizaciones se retrasan respecto a la última versión.** Cada
    actualización pasa por un proceso de cambio autorizado. Un esquema de
    soporte que solo cubra la última versión obliga a aceptar cambios de
    funcionalidad para obtener una corrección de seguridad, con el resultado
    previsible de que no se actualiza nada.
3.  **La urgencia se origina donde está la producción**, es decir en el
    despliegue privado, no en el repositorio público. Sin una vía definida, la
    presión de un incidente produce parches locales, y un parche local es el
    primer paso hacia un fork no declarado.

## Decisión

### 1. Versionado semántico sobre una superficie pública explícita

El núcleo sigue SemVer. La superficie pública —lo que un cambio incompatible
obliga a versionar como `major`— se limita deliberadamente a tres elementos:

*   **El esquema del payload de telemetría** que el agente envía al Hub.
*   **Los nombres de las variables de entorno** de configuración.
*   **La interfaz de plugins**, contra la que los despliegues privados
    implementan autenticación, persistencia y notificación.

Todo lo demás es detalle interno y puede cambiar en una versión de parche. Cada
elemento añadido a esa superficie es un elemento que no podrá cambiarse sin
forzar una migración, por lo que la superficie se mantiene mínima por diseño.

La versión y el registro de cambios se derivan de los mensajes de commit
(Conventional Commits) mediante `semantic-release`: `fix:` produce una versión de
parche, `feat:` una menor, y un cambio incompatible una mayor.

### 2. El payload declara su versión de esquema

Todo envío de telemetría incluye `schemaVersion` desde la primera
implementación del transporte:

```js
{ schemaVersion: 1, node: 'srv-web-01', status: 'DOWN', /* ... */ }
```

*   El Hub acepta `schemaVersion` N y N-1.
*   Los cambios de esquema son **aditivos**: campos nuevos opcionales. No se
    renombra ni se elimina ningún campo dentro de una misma versión.
*   Cuando un cambio incompatible sea inevitable, se incrementa `schemaVersion`
    y el Hub habla ambas versiones durante al menos un ciclo de despliegue.

Sin este campo, la única forma de cambiar el payload es un despliegue coordinado
de toda la flota, lo que implica una ventana con el monitoreo interrumpido.

### 3. Ventana de soporte y ramas de mantenimiento

A partir de la versión 1.0.0 se soportan la línea menor vigente y la
inmediatamente anterior. Las correcciones de seguridad se aplican en `main` y se
retroportan a la rama `release/1.x` correspondiente, de modo que un despliegue
pueda recibir la corrección sin adoptar cambios de funcionalidad.

### 4. Corrección aguas arriba primero

Un defecto detectado en un despliegue privado se corrige **en el repositorio
público**, se publica y se consume como versión nueva. No se parchea el
despliegue y se sincroniza después.

Como válvula para incidentes en curso se admite `pnpm patch`, que produce un
parche versionado y visible en el repositorio privado, sujeto a tres
condiciones: es temporal, exige un *pull request* abierto en el repositorio
público el mismo día, y se elimina al llegar la versión oficial. La integración
continua del repositorio privado falla si existe un parche sin *pull request*
asociado o con más de treinta días de antigüedad.

### 5. Propagación automatizada

El repositorio privado ejecuta Renovate, que abre un *pull request* por cada
versión publicada del núcleo con el registro de cambios en el cuerpo. Su
integración continua ejecuta los tests del núcleo y los de los plugins propios
antes de permitir la fusión. El despliegue posterior se hace primero a un nodo
canario y después al resto de la flota.

### 6. Tres artefactos de distribución por release

*   **Paquetes npm** — para construir el Hub y para despliegues que puedan
    instalar desde un registry.
*   **Imágenes de contenedor en GHCR** — para el Hub y para agentes en
    anfitriones con contenedores.
*   **Tarball autocontenido** — para agentes en sistemas heredados donde no hay
    contenedores ni salida a registries públicos.

El tercero no es redundante: es el único viable en un Windows Server antiguo o
en una red sin acceso a npm público.

## Alternativas descartadas

*   **Fork con fusiones periódicas desde el núcleo.** Descartado en el ADR 0005.
    En términos de esta decisión, además, hace imposible razonar sobre "qué
    versión corre en producción": la respuesta sería un hash de commit y un
    conjunto de conflictos resueltos a mano.
*   **CalVer (versionado por fecha, `2026.09.1`).** Comunica cuándo se publicó
    algo, que es útil, pero no comunica **si romperá algo al actualizar**, que es
    la única pregunta que un equipo de operaciones necesita responder antes de
    aprobar un cambio.
*   **Soportar únicamente la última versión.** Reduce el trabajo de
    mantenimiento a costa de acoplar cada corrección de seguridad a la adopción
    de funcionalidad nueva. El efecto observado en la práctica es que los
    despliegues dejan de actualizarse.
*   **Protocolo con negociación de versión (el agente pregunta al Hub qué habla).**
    Más flexible, pero requiere una petición previa a cada envío y convierte al
    agente en un cliente con estado de sesión. Un entero en el payload cubre el
    caso real con una fracción de la complejidad.
*   **Compatibilidad indefinida hacia atrás en el Hub.** Aceptar cualquier
    `schemaVersion` histórica suena generoso y acumula código de traducción que
    nadie prueba. Dos versiones cubren la ventana de despliegue, que es el
    problema concreto.
*   **Vendorizar el núcleo en el repositorio privado** (copiar el código fuente
    en lugar de dependerlo). Resuelve el acceso a npm, pero elimina la señal de
    versión: nadie sabría qué se copió ni cuándo.

## Consecuencias

**A favor:** actualizar es cambiar un número de versión, no resolver una fusión;
la ventana de despliegue deja de requerir interrupción del servicio; una
corrección de seguridad llega sin arrastrar cambios de funcionalidad; existe una
respuesta verificable a "qué versión corre en producción".

**En contra, y son costos reales:**

*   **Mantener ramas de release cuesta trabajo continuo.** Cada retroporte es una
    aplicación manual de un cambio a una base distinta, con su propia
    verificación. Es el precio de que alguien pueda quedarse una versión atrás.
*   **La regla de aditividad del esquema acumula campos.** A los dos años el
    payload tendrá campos que ya nadie usa y que no se pueden eliminar hasta el
    siguiente `schemaVersion`. Es deuda deliberada.
*   **El Hub carga código para dos versiones de esquema**, y la rama de la
    versión antigua se ejecuta solo durante las ventanas de despliegue, es decir,
    es la menos ejercitada y la más propensa a romperse sin que nadie lo note.
    Necesita tests propios, no solo los de la versión vigente.
*   **`semantic-release` convierte los mensajes de commit en API.** Un `fix:` mal
    etiquetado que en realidad rompe compatibilidad publica una versión de parche
    y rompe los despliegues que la adopten automáticamente.
*   **Renovate genera ruido.** Sin agrupación de *pull requests* ni ventanas de
    actualización, el repositorio privado recibe más propuestas de las que su
    proceso de cambios puede procesar, y el equipo empieza a ignorarlas.
*   **La superficie pública mínima limita el diseño.** Cambiar el nombre de una
    variable de entorno mal elegida cuesta una versión mayor, así que se
    convivirá con nombres imperfectos.
*   **Publicar tres artefactos triplica la matriz de publicación** y añade el
    riesgo de que uno de los tres quede desincronizado en una release.
