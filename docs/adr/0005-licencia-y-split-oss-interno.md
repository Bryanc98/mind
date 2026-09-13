# ADR 0005 — Apache-2.0, y la versión interna consume el núcleo como dependencia

*   **Estado:** aceptado
*   **Fecha:** 2026-09-07

## Contexto

El proyecto tiene dos alcances: un núcleo open source de distribución pública y
despliegues internos con integraciones propias de cada organización (directorio
corporativo, persistencia alternativa, SMTP interno, reglas de PII locales,
inventario de servidores).

El riesgo es conocido y tiene nombre: se hace un *fork* interno "temporal", se
parchea directo sobre él porque hay una urgencia, y a los seis meses son dos
proyectos distintos donde una corrección de seguridad hay que aplicar dos veces.

## Decisión

**Licencia: Apache-2.0.**

**Estructura: el repositorio público es una biblioteca; el interno es un consumidor.**

*   `mind` (público): el núcleo. Paquetes publicados en npm e imágenes en GHCR.
    **Cero contenido específico de ninguna organización.**
*   `mind-<organización>` (privado): declara los paquetes públicos como
    dependencias versionadas y aporta sus plugins en `plugins/`, más el despliegue
    real en `deploy/` con los secretos cifrados.

El mecanismo de extensión es un `mind.config.js` que **importa** módulos de plugin.
Sin cargador dinámico, sin descubrimiento por convención de nombres, sin registro de
plugins. Un `import` es rastreable por cualquier editor y por cualquier auditor.

**Regla operativa sin excepciones:** al repositorio público no entra ni un hostname,
ni una IP, ni un nombre de servidor, ni una convención de nomenclatura interna. Ni en
un test, ni en un comentario, ni en un mensaje de commit. Una vez en el historial de
git, está publicado; borrar el archivo después no lo deshace.

## Alternativas descartadas

*   **MIT.** Más corta y más popular. Descartada por una razón concreta: no incluye
    concesión expresa de patentes. Para que una institución adopte —y sobre todo
    para que la publique o la comparta con otra— la cláusula de patentes de
    Apache-2.0 elimina una pregunta del proceso legal. Ese es el único motivo, y
    basta.
*   **AGPL.** Obligaría a cualquiera que ofreciera el Hub como servicio a liberar sus
    cambios. Descartada: la mayoría de las instituciones tienen prohibido o
    restringido el uso de AGPL en producción, y el objetivo es que esto se adopte.
*   **Fork interno.** Descartado por lo dicho en el contexto.
*   **Submódulo de git apuntando al repo público.** Mejor que un fork, pero los
    submódulos obligan a todo el equipo a entender su ciclo de vida y se olvidan de
    actualizar. Una dependencia versionada es un mecanismo que el equipo ya conoce.
*   **Monorepo único con directorios privados y `.gitignore`.** Descartado: un
    `.gitignore` es una convención, no un control de acceso. Un `git add -f` a
    destiempo publica infraestructura interna. La separación tiene que ser física.

## Consecuencias

**A favor:** la corrección se hace una vez; la disciplina de no meter nada interno en
el núcleo **fuerza** a que las interfaces queden bien abstraídas, que es el beneficio
de diseño que se busca aquí; el repositorio público sirve de portafolio.

**En contra, y es fricción diaria:**

*   **Un cambio que necesita tocar el núcleo requiere dos PRs y una publicación de
    versión** antes de poder usarse en el interno. Bajo presión, esa fricción es
    exactamente lo que empuja a parchear el interno "solo por esta vez". Mitigación:
    `pnpm link` para desarrollo local, pero la regla es que nada llega a producción
    interna sin haber pasado por el público.
*   **Hay que diseñar la interfaz de plugin antes de tener el segundo caso de uso.**
    Es la receta clásica de una abstracción equivocada. Mitigación: definir la
    interfaz solo cuando exista el primer plugin institucional real y haya un
    requisito concreto, no antes.
*   **Publicar en npm implica versionado semántico en serio.** Romper el contrato en
    un `patch` rompe el repo interno.
*   **Dos CI, dos juegos de secretos, dos tableros de issues.**
*   **Apache-2.0 obliga a mantener `NOTICE` y las cabeceras de licencia**, que es
    burocracia que MIT no tiene.
