# VideoChatService

Microservicio de videollamadas y chat en tiempo real para una plataforma de psicología. Este servicio permite que psicólogos y pacientes realicen videollamadas grupales (hasta 20 participantes) con chat integrado.

## Descripción General

Este microservicio implementa:
- **Señalización WebRTC**: Gestión de conexiones peer-to-peer entre usuarios.
- **Chat en tiempo real**: Mensajería simultánea durante las videollamadas usando WebSocket.
- **Autenticación**: Control de acceso basado en tipos de usuario (psicólogo, paciente).
- **Gestión de salas**: Creación y control de salas de videollamada.
- **Escalabilidad futura**: Preparación para integración de SFU (Selective Forwarding Unit) para más de 4-6 participantes.

## Tecnologías Utilizadas

- **Backend**: Node.js
- **Comunicación en tiempo real**: WebSocket (Socket.IO)
- **Autenticación**: JWT (JSON Web Tokens)
- **Protocolo de video**: WebRTC
- **Señalización**: Custom signaling protocol sobre WebSocket

## Estructura del Proyecto

```
VideoChatService/
├── README.md
├── package.json
├── server.js
├── .env
├── src/
│   ├── controllers/
│   ├── services/
│   ├── routes/
│   ├── middleware/
│   ├── models/
│   └── utils/
├── docs/
│   └── API.md
└── docker/
    └── Dockerfile
```

## Plan de Implementación

### Fase 1: Análisis y Diseño
**Objetivo**: Definir requisitos, arquitectura y flujos.

**Tareas**:
1. Definir requisitos funcionales y no funcionales.
2. Seleccionar tecnologías: Node.js, WebRTC, WebSocket, JWT, framework frontend.
3. Diseñar arquitectura general y diagramas de componentes.
4. Definir endpoints de API y flujos de señalización.
5. Especificar modelo de datos (usuarios, salas, mensajes).

**Dependencias**: Ninguna.

**Puntos de verificación**:
- Documentación de requisitos y arquitectura aprobada.
- Diagramas de componentes y flujos revisados.

---

### Fase 2: Configuración del Entorno y Estructura Base
**Objetivo**: Preparar el proyecto base con dependencias y estructura.

**Tareas**:
1. Inicializar proyecto Node.js y configurar dependencias principales.
   - Instalar: `express`, `socket.io`, `jsonwebtoken`, `dotenv`, etc.
2. Configurar servidor HTTP/HTTPS.
3. Configurar WebSocket para señalización y chat.
4. Estructurar carpetas: `controllers/`, `services/`, `routes/`, `middleware/`, `models/`, `utils/`.

**Dependencias**: Fase 1 completada.

**Puntos de verificación**:
-  Proyecto inicializado y servidor básico ejecutable.
-  Estructura de carpetas y dependencias instaladas.
-  WebSocket funcionando sin errores.

---

### Fase 3: Implementación de Autenticación Básica
**Objetivo**: Implementar autenticación segura para usuarios.

**Tareas**:
1. Implementar registro y login de usuarios (puede ser mock o con base de datos simple).
2. Generar y validar tokens JWT.
3. Crear middleware para proteger rutas y sockets autenticados.
4. Diferenciar roles: psicólogo, paciente.

**Dependencias**: Fase 2 completada.

**Puntos de verificación**:
-  Usuarios pueden registrarse e iniciar sesión.
-  Rutas y WebSocket protegidos por autenticación.
-  JWT validado correctamente.

---


### Fase 4: Señalización WebRTC (¡Completada!)
**Objetivo**: Permitir la señalización WebRTC para videollamadas grupales mediante WebSocket.

**¿Cómo funciona?**
El backend implementa un protocolo de señalización sobre Socket.IO para que los clientes puedan intercambiar ofertas, respuestas y candidatos ICE, y así establecer conexiones peer-to-peer (P2P) de WebRTC.

**Eventos WebSocket implementados:**
- `webrtc:join-room`: Un usuario se une a una sala de videollamada. El servidor notifica a los demás y entrega la lista de participantes existentes.
- `webrtc:existing-participants`: El usuario recibe la lista de participantes activos al entrar a la sala.
- `webrtc:user-joined`: Notifica a los usuarios de la sala que un nuevo participante se ha unido.
- `webrtc:offer`: Un usuario envía una oferta SDP a otro usuario (señalización WebRTC).
- `webrtc:answer`: Un usuario responde a una oferta SDP.
- `webrtc:ice-candidate`: Un usuario envía un ICE candidate a otro usuario.
- `webrtc:user-left`: Notifica que un usuario ha abandonado la sala.
- `webrtc:left-room`: Confirmación de salida de sala.
- `webrtc:participants`: Lista actualizada de participantes (también se emite en eventos de chat).
- `webrtc:error`: Errores de validación o flujo.

**Flujo típico:**
1. Cliente A y B se conectan y hacen `webrtc:join-room`.
2. El servidor notifica a cada uno sobre los participantes existentes y nuevos.
3. Los clientes intercambian `webrtc:offer`, `webrtc:answer` y `webrtc:ice-candidate` para establecer la conexión P2P.
4. Al salir, se emite `webrtc:user-left` y se actualiza la lista de participantes.

**Notas:**
- El backend no manipula los datos SDP ni ICE, solo los reenvía al destinatario correcto.
- El control de salas y participantes es robusto y soporta grupos.
- Validado con pruebas automáticas en `tests/webrtc-signaling-test.js`.

**Estado:** ¡Señalización WebRTC completada y probada!

---


### Fase 5: Chat en Tiempo Real (¡Completada y robusta!)
**Objetivo**: Proveer mensajería persistente, segura y validada dentro de las videollamadas.

**¿Cómo funciona?**
El backend implementa un chat en tiempo real sobre Socket.IO, con persistencia en MongoDB, validación estricta, deduplicación, rate limiting, sanitización y control de membresía. El chat está validado con pruebas automáticas de extremo a extremo.

**Eventos WebSocket implementados:**
- `chat:join-room`: Un usuario entra a una sala y actualiza participantes.
- `chat:send-message`: Envía un mensaje a todos en la sala (con validación, deduplicación y rate limit).
- `chat:receive-message`: Evento emitido por el servidor con el mensaje recibido (ya sanitizado y persistido).
- `chat:leave-room`: Un usuario sale de una sala.
- `chat:participants`: Lista actualizada de participantes de una sala.
- `chat:error`: Errores de validación, membresía, duplicados o rate limit.
- `chat:ack`: Confirmación de recepción y persistencia del mensaje.

**Endpoint REST para historial:**
- `GET /api/chat/:roomId/messages` (retorna últimos 50 mensajes persistidos en MongoDB)

**Robustez y seguridad:**
- **Validación**: Todos los mensajes y eventos son validados (payload, tipos, longitud, IDs).
- **Deduplicación**: Mensajes duplicados (por clientMessageId) son descartados.
- **Rate limiting**: Límite configurable de mensajes por usuario/sala/tiempo.
- **Membresía**: Solo miembros de la sala pueden enviar/recibir mensajes.
- **Sanitización**: El contenido de los mensajes es limpiado para evitar XSS y spam.
- **Persistencia**: Todos los mensajes se almacenan en MongoDB con IDs únicos y timestamps.

**Pruebas automáticas:**
- Validación, deduplicación, rate limit, sanitización y membresía probadas en `tests/chat-realtime-test.js`.
- El chat pasa todas las pruebas E2E y unitarias.

**Estado:** ¡Chat robusto, persistente y validado, listo para producción!

---

### Fase 6: Integración con Frontend
**Objetivo**: Conectar servicios backend con interfaz de usuario.

**Tareas**:
1. Crear interfaz básica:
   - Pantalla de login (psicólogo/paciente).
   - Panel de salas disponibles.
   - Interfaz de videollamada con chat integrado.
2. Integrar frontend con endpoints de autenticación.
3. Integrar WebSocket para señalización y chat.
4. Implementar manejo de flujos de medios:
   - `getUserMedia()` para cámara/micrófono.
   - `RTCPeerConnection` para video/audio.
5. Pruebas de extremo a extremo (E2E).

**Dependencias**: Fases 3, 4, 5 completadas.

**Puntos de verificación**:
- Frontend funciona con autenticación.
- Videollamada funciona entre 2 usuarios.
- Chat en tiempo real funciona.
- Pruebas E2E exitosas.

---

### Fase 7: Pruebas, Documentación y Despliegue
**Objetivo**: Validar, documentar y desplegar el servicio.

**Tareas**:
1. Implementar pruebas:
   - Unitarias: servicios y controladores.
   - Integración: flujos de autenticación y señalización.
   - E2E: casos de uso completos.
2. Documentar:
   - API REST y WebSocket.
   - Flujos de señalización.
   - Guía de instalación y desarrollo.
3. Preparar despliegue:
   - Crear `Dockerfile` para containerización.
   - Scripts de CI/CD (GitHub Actions, Azure DevOps, etc.).
   - Variables de entorno (`.env`).
4. Desplegar en entorno de pruebas (Azure, AWS, etc.).

**Dependencias**: Fase 6 completada.

**Puntos de verificación**:
- Todas las pruebas pasan.
- Documentación completa y clara.
- Microservicio desplegado y accesible.
- Logs y monitoreo configurados.

---

### Fase 8: Integración de SFU (Futura)
**Objetivo**: Escalar a más de 4-6 participantes con arquitectura SFU.

**Tareas**:
1. Investigar y evaluar opciones de SFU:
   - mediasoup (Node.js + C++).
   - Janus (C).
   - Jitsi Videobridge (Java).
   - Ion-SFU (Go).
2. Diseñar integración con el microservicio actual:
   - Cómo los clientes se conectan al SFU.
   - Gestión de salas en el SFU.
   - Persistencia de mensajes.
3. Implementar y probar integración.
4. Actualizar documentación y despliegue.

**Dependencias**: Fases anteriores validadas en producción.

**Puntos de verificación**:
- SFU integrado y funcional.
- Videollamadas con 20+ usuarios sin degradación.
- Documentación actualizada.

---

## Matriz de Dependencias

```
Fase 1 (Análisis)
    ↓
Fase 2 (Configuración)
    ↓
Fase 3 (Autenticación)
    ↓
Fase 4 (Señalización WebRTC)
    ↓
Fase 5 (Chat)
    ↓
Fase 6 (Frontend)
    ↓
Fase 7 (Pruebas/Despliegue)
    ↓
Fase 8 (SFU - Futura)
```

## Checkpoints de Verificación

| Fase | Objetivo | Estado |
|------|----------|--------|
| 1 | Análisis y diseño | Completada |
| 2 | Configuración base | Completada |
| 3 | Autenticación | En progreso |
| 4 | Señalización | Completada |
| 5 | Chat | En progreso |
| 6 | Frontend | Pendiente |
| 7 | Pruebas/Despliegue | Pendiente |
| 8 | SFU (Futura) | Planificada |

## Chat WebSocket Implementado (Backend)

Eventos de Socket.IO ya disponibles en el servidor:

- `chat:join-room` -> un usuario entra a una sala y actualiza participantes.
- `chat:send-message` -> envía un mensaje a todos en la sala.
- `chat:receive-message` -> evento emitido por el servidor con el mensaje recibido.
- `chat:leave-room` -> un usuario sale de una sala.
- `chat:participants` -> lista actualizada de participantes de una sala.
- `chat:error` -> errores de validación de payload.

Endpoint disponible para historial (si MongoDB está conectado):

- `GET /api/chat/:roomId/messages` (retorna últimos 50 mensajes)

## Consideraciones Importantes

### Escalabilidad
- Para 2-4 usuarios: WebRTC P2P es suficiente.
- Para 5-20 usuarios: Se implementará SFU en Fase 8.

### Seguridad
- Autenticación JWT en todas las rutas y WebSocket.
- Validación de roles (psicólogo, paciente).
- HTTPS/WSS en producción.

### Rendimiento
- WebSocket para comunicación en tiempo real.
- Compresión de mensajes si es necesario.
- Monitoreo de latencia y ancho de banda.

### Testing
- Pruebas unitarias para lógica de negocio.
- Pruebas de integración para flujos.
- Pruebas E2E para casos de uso reales.


## Despliegue

### Requisitos
- Node.js v16+
- Docker (opcional, para containerización)

### Instalación Local

```bash
npm install
npm start
```

### Despliegue en Azure

```bash
# Configurar variables de entorno
cp .env.example .env

# Desplegar con Docker
docker build -t videochatservice .
docker run -p 3000:3000 videochatservice
```

## Variables de Entorno

```
NODE_ENV=development
PORT=3000
JWT_SECRET=your_secret_key
DATABASE_URL=your_database_url
CORS_ORIGIN=http://localhost:3000
```

## Licencia

Este proyecto está bajo la licencia MIT.