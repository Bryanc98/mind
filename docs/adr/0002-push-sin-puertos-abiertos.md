# ADR 0002 — Telemetría por push, sin puertos de escucha y sin ejecución remota

*   **Estado:** aceptado
*   **Fecha:** 2026-09-07

## Contexto

M.I.N.D. tiene que desplegarse en servidores de una institución gubernamental. El
obstáculo real de adopción en ese entorno no es técnico, es la revisión de seguridad:
cada puerto que se abre y cada regla de firewall que se solicita es un trámite con
un responsable que tiene que firmarlo.

El modelo dominante en monitoreo es el opuesto. Prometheus hace *pull*: el servidor
central se conecta a cada nodo, que expone un puerto HTTP (9100 para node_exporter).
Con 40 nodos son 40 puertos abiertos y 40 reglas, y un servidor central que necesita
alcanzar a todos.

## Decisión

1.  **El agente no abre ningún socket de escucha.** Toda la comunicación es
    unidireccional de salida por HTTPS hacia el Hub.
2.  **El Hub no puede ejecutar nada en los nodos.** No hay endpoint de comandos, no
    hay reinicio remoto, no hay ejecución de scripts, no hay escritura de archivos.
    El agente **solo lee y envía**.

El punto 2 no es una opción de configuración que se pueda activar: la capacidad no
existe en el código. Es la diferencia entre "está deshabilitado" y "no se puede".

## Alternativas descartadas

*   **Pull estilo Prometheus.** Descartado: convierte cada nodo en un servicio
    expuesto y hace que la adopción dependa de N solicitudes de firewall.
*   **Push con capacidad de comandos (agente bidireccional).** Es lo que hacen casi
    todas las herramientas comerciales, y es tentador: "si detectamos que el servicio
    murió, reinícialo automáticamente". Descartado deliberadamente. Un agente con esa
    capacidad, corriendo en toda la flota, es la mejor herramienta de movimiento
    lateral que un atacante podría pedir: comprometes el Hub y tienes ejecución de
    código en todos los servidores de la institución. El valor de la
    auto-remediación no compensa ese riesgo, y además hace que el sistema pase de
    "observabilidad" a "gestión de configuración", que es un producto distinto con
    otras exigencias.
*   **Túnel VPN o WireGuard entre Hub y nodos.** Resuelve la conectividad pero añade
    un componente de infraestructura que hay que operar, y no elimina la ejecución
    remota: solo la esconde detrás de un túnel.
*   **SNMP.** Estándar y ya permitido en muchas redes. Descartado: no da acceso a
    logs de aplicación, que es de donde sale el diagnóstico de causa raíz.

## Consecuencias

**A favor:** la revisión de seguridad se vuelve corta y verificable; un nodo
comprometido no puede atacar al Hub más allá de enviarle datos basura; el diseño se
puede auditar leyendo el código, no la configuración.

**En contra, y es un costo real:**

*   **No hay auto-remediación, nunca.** Es la primera cosa que va a pedir el equipo
    de operaciones cuando vean la herramienta funcionando. La respuesta es no, y esta
    página es la explicación. Si algún día se decide que sí, tiene que ser un
    producto separado con su propio modelo de amenazas, no un endpoint añadido aquí.
*   **No se puede consultar un nodo bajo demanda.** El Hub tiene la foto del último
    reporte, no la actual. Si necesitas saber el estado *ahora*, esperas al siguiente
    intervalo. La única forma de acelerarlo es bajar el intervalo, que sube el ruido.
*   **La configuración se distribuye por fuera.** Cambiar un umbral en 40 nodos
    requiere Ansible (etapa 7), no un botón en el dashboard.
*   **La caída de un nodo se detecta por ausencia**, no por error, lo que obliga a
    implementar un *dead man's switch* en el Hub. Es más código que un chequeo
    activo, y es un punto de fallo silencioso si se implementa mal.
