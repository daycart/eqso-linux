# Credenciales en diagnósticos eQSO

Los JOIN eQSO llevan la contraseña o token en el paquete. Los logs anteriores
que incluyan tramas completas, hexadecimales o mensajes de error sin filtrar
deben tratarse como potencialmente expuestos. Dejar de registrarlos no revoca
las credenciales que ya aparecieron allí.

Tras instalar la versión que elimina esos volcados:

1. Restringir el acceso a los logs antiguos y revisar su retención y copias.
   No pegar paquetes, contraseñas ni tokens en incidencias o chats.
2. Inventariar con el operador qué equipos siguen usando cada credencial,
   especialmente los clientes eQSO 1.13 y la entrada «Servidor Local».
3. Crear credenciales individuales nuevas, actualizar los equipos por turnos
   y confirmar una conexión correcta de cada uno **antes** de revocar las
   anteriores. Para las claves compartidas, coordinar la rotación con todos
   los clientes dependientes y retirarlas solo tras confirmar la migración.
4. Considerar comprometida cualquier credencial que haya aparecido en logs
   históricos, incluso si la versión nueva ya no la registra.