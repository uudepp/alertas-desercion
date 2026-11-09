# Alertas de deserción UDEP

Sitio de consulta protegido mediante cifrado en el navegador. La publicación
contiene una pantalla de acceso, recursos públicos de presentación y archivos
cifrados. Los nombres, documentos, trayectorias y puntajes no se publican en claro.

La consulta requiere la contraseña entregada por el responsable del proyecto.
El sitio funciona mediante HTTPS y un navegador con Web Crypto, Service Worker
y descompresión gzip. Las fichas mantienen los datos y la presentación de la
entrega local; las probabilidades no se recalculan al publicar.

Para actualizar, el responsable actualiza primero las fichas del proyecto y
ejecuta su publicador local. No se deben subir a este repositorio las fuentes,
credenciales, la contraseña, bases de datos ni exportaciones sin cifrar.

La contraseña no figura en este repositorio. En la computadora del responsable,
se consulta en `2.intermedios/publicacion_web/acceso.txt`, fuera de esta carpeta.
No debe compartirse ese archivo junto con el repositorio.

La rotación de contraseña protege la publicación nueva. No borra las revisiones
anteriores del historial Git ni revoca copias previamente descargadas.
