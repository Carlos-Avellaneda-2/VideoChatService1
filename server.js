/**
 * VideoChatService - Servidor SFU principal
 * Configuración de Express, Socket.IO y Mediasoup
 * 
 * Estado: Fase 8 - Arquitectura SFU con Mediasoup
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const { v4: uuidv4 } = require('uuid');
const mediasoup = require('mediasoup');
const Message = require('./src/models/Message');
const Room = require('./src/models/Room');
const User = require('./src/models/User');

const app = express();
const server = http.createServer(app);
function isAllowedOrigin(origin) {
  if (!origin) {
    return true;
  }

  try {
    const parsed = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch {
    return origin === process.env.CORS_ORIGIN;
  }
}

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin) || origin === process.env.CORS_ORIGIN) {
      callback(null, true);
      return;
    }

    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  credentials: true,
};

const io = socketIO(server, {
  cors: corsOptions,
});


// Middleware
app.use(express.json());
app.use(cors(corsOptions));

const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'VideoChatService API',
    version: '1.0.0',
    description: 'Documentacion Swagger del microservicio VideoChatService',
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Message: {
        type: 'object',
        properties: {
          messageId: { type: 'string' },
          clientMessageId: { type: 'string' },
          roomId: { type: 'string' },
          senderId: { type: 'string' },
          content: { type: 'string' },
          type: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
};

const swaggerOptions = {
  swaggerDefinition,
  apis: ['./server.js', './src/routes/*.js'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Rutas de autenticación
const authRoutes = require('./src/routes/authRoutes');
app.use('/api/auth', authRoutes);


/**
 * @swagger
 * /:
 *   get:
 *     summary: Estado del servidor
 *     description: Retorna mensaje de estado del microservicio.
 *     responses:
 *       200:
 *         description: Servidor ejecutando
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 */
app.get('/', (req, res) => {
  res.json({ message: 'VideoChatService - Servidor ejecutando' });
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Healthcheck
 *     description: Retorna el estado de salud del servicio.
 *     responses:
 *       200:
 *         description: Estado OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Estado simple de salas en memoria (participantes conectados)
const roomParticipants = new Map();
const chatRateTracker = new Map();
const recentMessages = new Map();

// Mediasoup - Gestión de salas, routers y productores
const mediasoupRoom = new Map(); // roomId -> { router, producers, consumers, transports }
let mediasoupWorker = null;

const CHAT_MAX_MESSAGE_LENGTH = Number(process.env.CHAT_MAX_MESSAGE_LENGTH || 1000);
const CHAT_RATE_LIMIT_WINDOW_MS = Number(process.env.CHAT_RATE_LIMIT_WINDOW_MS || 5000);
const CHAT_RATE_LIMIT_MAX_MESSAGES = Number(process.env.CHAT_RATE_LIMIT_MAX_MESSAGES || 7);
const CHAT_DUPLICATE_WINDOW_MS = Number(process.env.CHAT_DUPLICATE_WINDOW_MS || 3000);

function normalizeId(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

async function findUserForTest(idValue, emailValue, expectedRole) {
  const normalizedId = normalizeId(idValue);
  const normalizedEmail = normalizeId(emailValue).toLowerCase();

  let user = null;
  if (normalizedId && mongoose.Types.ObjectId.isValid(normalizedId)) {
    user = await User.findById(normalizedId).lean();
  }

  if (!user && normalizedEmail) {
    user = await User.findOne({ email: normalizedEmail }).lean();
  }

  if (!user) {
    return { error: `No existe usuario para rol ${expectedRole}` };
  }

  if (user.role !== expectedRole) {
    return {
      error: `El usuario ${user.email} no tiene rol ${expectedRole}`,
    };
  }

  return { user };
}

function sanitizeChatText(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isUserInRoom(roomId, userId) {
  const participantsMap = roomParticipants.get(roomId);
  return Boolean(participantsMap && participantsMap.has(userId));
}

function createRateLimitKey(roomId, userId) {
  return `${roomId}::${userId}`;
}

function isRateLimited(roomId, userId) {
  const now = Date.now();
  const key = createRateLimitKey(roomId, userId);
  const timestamps = chatRateTracker.get(key) || [];
  const validTimestamps = timestamps.filter((ts) => now - ts <= CHAT_RATE_LIMIT_WINDOW_MS);
  validTimestamps.push(now);
  chatRateTracker.set(key, validTimestamps);

  return validTimestamps.length > CHAT_RATE_LIMIT_MAX_MESSAGES;
}

function createMessageFingerprint(roomId, senderId, content, clientMessageId) {
  if (clientMessageId) {
    return `id:${clientMessageId}`;
  }

  return `content:${roomId}:${senderId}:${content}`;
}

function isDuplicateMessage(roomId, senderId, content, clientMessageId) {
  const now = Date.now();
  const roomMap = recentMessages.get(roomId) || new Map();
  const fingerprint = createMessageFingerprint(roomId, senderId, content, clientMessageId);
  const lastTimestamp = roomMap.get(fingerprint);

  for (const [key, timestamp] of roomMap.entries()) {
    if (now - timestamp > CHAT_DUPLICATE_WINDOW_MS) {
      roomMap.delete(key);
    }
  }

  const isDuplicate = typeof lastTimestamp === 'number' && now - lastTimestamp <= CHAT_DUPLICATE_WINDOW_MS;
  roomMap.set(fingerprint, now);
  recentMessages.set(roomId, roomMap);

  return isDuplicate;
}

function getRoomParticipants(roomId) {
  const participantsMap = roomParticipants.get(roomId);
  if (!participantsMap) {
    return [];
  }

  return Array.from(participantsMap.values()).map((participant) => ({
    userId: participant.userId,
    role: participant.role,
    socketId: participant.socketId,
  }));
}

/**
 * Inicializar el worker de Mediasoup
 */
async function initMediasoup() {
  try {
    mediasoupWorker = await mediasoup.createWorker({
      logLevel: 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp', 'rtx', 'bwe', 'score', 'simulcast', 'svc'],
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
    });

    console.log(`[Mediasoup] Worker creado con PID ${mediasoupWorker.pid}`);

    mediasoupWorker.on('died', () => {
      console.error('[Mediasoup] El worker ha muerto. Intentando reiniciar...');
      setTimeout(() => {
        initMediasoup();
      }, 2000);
    });

    return mediasoupWorker;
  } catch (error) {
    console.error('[Mediasoup] Error al crear worker:', error);
    throw error;
  }
}

/**
 * Obtener o crear un router de Mediasoup para una sala
 */
async function getOrCreateRouter(roomId) {
  if (mediasoupRoom.has(roomId)) {
    return mediasoupRoom.get(roomId).router;
  }

  if (!mediasoupWorker) {
    throw new Error('Mediasoup worker no está inicializado');
  }

  const mediaCodecs = [
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
    },
    {
      kind: 'video',
      mimeType: 'video/VP8',
      clockRate: 90000,
      parameters: {
        'x-google-start-bitrate': 1000,
      },
    },
    {
      kind: 'video',
      mimeType: 'video/H264',
      clockRate: 90000,
      parameters: {
        'profile-level-id': '4d0032',
        'level-asymmetry-allowed': 1,
        'packetization-mode': 1,
      },
    },
  ];

  const router = await mediasoupWorker.createRouter({ mediaCodecs });

  mediasoupRoom.set(roomId, {
    router,
    producers: new Map(), // userId -> { audio: producer, video: producer }
    consumers: new Map(), // userId -> Map(producerId -> consumer)
    transports: new Map(), // socketId -> transport
  });

  console.log(`[Mediasoup] Router creado para sala ${roomId}`);
  return router;
}

/**
 * Obtener los datos de una sala de mediasoup
 */
function getRoomData(roomId) {
  if (!mediasoupRoom.has(roomId)) {
    return null;
  }
  return mediasoupRoom.get(roomId);
}

/**
 * Limpiar una sala de mediasoup cuando se vacía
 */
async function cleanupRoom(roomId) {
  const roomData = mediasoupRoom.get(roomId);
  if (!roomData) return;

  try {
    // Cerrar todos los transportes
    for (const transport of roomData.transports.values()) {
      await transport.close();
    }

    // El router se cerrará automáticamente cuando todos los recursos se liberen
    console.log(`[Mediasoup] Sala ${roomId} limpiada`);
  } catch (error) {
    console.error(`[Mediasoup] Error al limpiar sala ${roomId}:`, error.message);
  }

  mediasoupRoom.delete(roomId);
}

function broadcastParticipants(roomId) {
  const participants = getRoomParticipants(roomId);

  io.to(roomId).emit('chat:participants', {
    roomId,
    participants: participants.map((p) => ({ userId: p.userId, role: p.role })),
  });

  io.to(roomId).emit('webrtc:participants', {
    roomId,
    participants: participants.map((p) => ({ userId: p.userId, role: p.role })),
  });
}

async function joinRoom(socket, payload = {}) {
  const { roomId, userId, role = 'unknown' } = payload;

  if (!roomId || !userId) {
    socket.emit('chat:error', { message: 'roomId y userId son requeridos' });
    socket.emit('webrtc:error', { message: 'roomId y userId son requeridos' });
    return false;
  }

  const participantsMap = roomParticipants.get(roomId);
  const currentCount = participantsMap ? participantsMap.size : 0;

  let maxParticipants = 100;
  if (mongoose.connection.readyState === 1) {
    try {
      const room = await Room.findById(roomId).lean();
      if (room) {
        maxParticipants = room.maxParticipants;
      }
    } catch {
      // Si no está en BD, usa default
    }
  }

  if (currentCount >= maxParticipants) {
    socket.emit('chat:error', {
      message: `La sala está llena. Máximo de participantes: ${maxParticipants}`,
    });
    socket.emit('webrtc:error', {
      message: `La sala está llena. Máximo de participantes: ${maxParticipants}`,
    });
    return false;
  }

  const previousRoomId = socket.data.roomId;
  const previousUserId = socket.data.userId;
  if (previousRoomId && previousUserId && previousRoomId !== roomId) {
    leaveRoom(socket, { roomId: previousRoomId, userId: previousUserId }, false);
  }

  socket.join(roomId);
  socket.data.userId = userId;
  socket.data.roomId = roomId;
  socket.data.role = role;

  if (!roomParticipants.has(roomId)) {
    roomParticipants.set(roomId, new Map());
  }

  roomParticipants.get(roomId).set(userId, {
    userId,
    role,
    socketId: socket.id,
  });

  const participants = getRoomParticipants(roomId);
  const existingParticipants = participants
    .filter((participant) => participant.userId !== userId)
    .map((participant) => ({
      userId: participant.userId,
      role: participant.role,
    }));

  socket.emit('webrtc:existing-participants', {
    roomId,
    participants: existingParticipants,
  });

  socket.to(roomId).emit('webrtc:user-joined', {
    roomId,
    user: { userId, role },
  });

  broadcastParticipants(roomId);
  return true;
}

function leaveRoom(socket, payload = {}, notifySelf = true) {
  const roomId = payload.roomId || socket.data.roomId;
  const userId = payload.userId || socket.data.userId;

  if (!roomId || !userId) {
    return;
  }

  socket.leave(roomId);

  const participantsMap = roomParticipants.get(roomId);
  if (participantsMap) {
    participantsMap.delete(userId);
    if (participantsMap.size === 0) {
      roomParticipants.delete(roomId);
    }
  }

  socket.to(roomId).emit('webrtc:user-left', {
    roomId,
    userId,
  });

  if (notifySelf) {
    socket.emit('webrtc:left-room', { roomId, userId });
  }

  broadcastParticipants(roomId);

  socket.data.roomId = null;
  socket.data.userId = null;
  socket.data.role = null;
}

function forwardSignaling(socket, payload = {}, signalType) {
  const { roomId, targetUserId, senderId, sdp, candidate } = payload;

  if (!roomId || !targetUserId || !senderId) {
    socket.emit('webrtc:error', {
      message: 'roomId, targetUserId y senderId son requeridos',
      signalType,
    });
    return;
  }

  const participantsMap = roomParticipants.get(roomId);
  if (!participantsMap) {
    socket.emit('webrtc:error', {
      message: 'La sala no existe',
      roomId,
      signalType,
    });
    return;
  }

  const targetParticipant = participantsMap.get(targetUserId);
  if (!targetParticipant) {
    socket.emit('webrtc:error', {
      message: 'Usuario destino no encontrado en la sala',
      roomId,
      targetUserId,
      signalType,
    });
    return;
  }

  if (signalType === 'offer') {
    io.to(targetParticipant.socketId).emit('webrtc:offer', { roomId, senderId, sdp });
    return;
  }

  if (signalType === 'answer') {
    io.to(targetParticipant.socketId).emit('webrtc:answer', { roomId, senderId, sdp });
    return;
  }

  if (signalType === 'ice-candidate') {
    io.to(targetParticipant.socketId).emit('webrtc:ice-candidate', {
      roomId,
      senderId,
      candidate,
    });
  }
}


/**
 * @swagger
 * /api/chat/{roomId}/messages:
 *   get:
 *     summary: Obtener historial de mensajes de una sala
 *     description: Retorna los últimos mensajes persistidos de una sala de chat.
 *     parameters:
 *       - in: path
 *         name: roomId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID de la sala
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *         description: Cantidad máxima de mensajes a retornar (por defecto 50)
 *     responses:
 *       200:
 *         description: Lista de mensajes
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Message'
 *       400:
 *         description: roomId es requerido
 *       500:
 *         description: Error interno
 */
app.get('/api/chat/:roomId/messages', async (req, res) => {
  const roomId = normalizeId(req.params.roomId);
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
    : 50;

  if (!roomId) {
    return res.status(400).json({ error: 'roomId es requerido' });
  }

  try {
    if (mongoose.connection.readyState === 1) {
      const messages = await Message.find({ roomId }).sort({ timestamp: -1 }).limit(limit).lean();
      return res.json(messages.reverse());
    }
    return res.json([]);
  } catch (error) {
    return res.status(500).json({ error: 'No se pudo obtener el historial' });
  }
});

/**
 * @swagger
 * /api/test/rooms:
 *   post:
 *     summary: Crear sala de prueba entre psicólogo y paciente
 *     description: Crea una sala privada en MongoDB para pruebas manuales de chat/videollamada. Soporta límite configurable de participantes.
 *     tags: [Testing]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               psychologistId:
 *                 type: string
 *               psychologistEmail:
 *                 type: string
 *               patientId:
 *                 type: string
 *               patientEmail:
 *                 type: string
 *               name:
 *                 type: string
 *               maxParticipants:
 *                 type: number
 *                 minimum: 1
 *                 maximum: 500
 *                 default: 100
 *             description: Puedes enviar id o email para cada usuario. maxParticipants es configurable (1-500, default 100).
 *     responses:
 *       201:
 *         description: Sala creada
 *       400:
 *         description: Datos inválidos
 *       503:
 *         description: MongoDB no disponible
 */
app.post('/api/test/rooms', async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: 'MongoDB no disponible para crear salas de prueba' });
  }

  const {
    psychologistId,
    psychologistEmail,
    patientId,
    patientEmail,
    name,
    maxParticipants,
  } = req.body || {};

  const hasPsychologistSelector = Boolean(normalizeId(psychologistId) || normalizeId(psychologistEmail));
  const hasPatientSelector = Boolean(normalizeId(patientId) || normalizeId(patientEmail));

  if (!hasPsychologistSelector || !hasPatientSelector) {
    return res.status(400).json({
      error: 'Debes enviar psychologistId/psychologistEmail y patientId/patientEmail',
    });
  }

  try {
    const [psychologistResult, patientResult] = await Promise.all([
      findUserForTest(psychologistId, psychologistEmail, 'psicologo'),
      findUserForTest(patientId, patientEmail, 'paciente'),
    ]);

    if (psychologistResult.error) {
      return res.status(400).json({ error: psychologistResult.error });
    }

    if (patientResult.error) {
      return res.status(400).json({ error: patientResult.error });
    }

    const psychologist = psychologistResult.user;
    const patient = patientResult.user;
    const finalMaxParticipants = maxParticipants
      ? Math.max(1, Math.min(500, Number(maxParticipants)))
      : 100;
    const room = await Room.create({
      name:
        normalizeId(name) ||
        `Prueba ${psychologist.email} y ${patient.email} - ${new Date().toISOString()}`,
      type: 'privado',
      participants: [psychologist._id, patient._id],
      maxParticipants: finalMaxParticipants,
    });

    return res.status(201).json({
      roomId: String(room._id),
      roomName: room.name,
      maxParticipants: room.maxParticipants,
      participants: [
        {
          id: String(psychologist._id),
          email: psychologist.email,
          role: psychologist.role,
        },
        {
          id: String(patient._id),
          email: patient.email,
          role: patient.role,
        },
      ],
      frontendChatPath: `/paciente/chat/${room._id}`,
    });
  } catch (error) {
    return res.status(500).json({ error: 'No se pudo crear la sala de prueba' });
  }
});

// WebSocket - Socket.IO
io.on('connection', (socket) => {
  console.log(`[Socket.IO] Cliente conectado: ${socket.id}`);

  socket.on('chat:join-room', async (payload) => {
    await joinRoom(socket, payload);
  });

  socket.on('webrtc:join-room', async (payload) => {
    await joinRoom(socket, payload);
  });

  socket.on('chat:send-message', async (payload = {}, callback) => {
    const roomId = normalizeId(payload.roomId);
    const senderId = normalizeId(payload.senderId);
    const clientMessageId = normalizeId(payload.clientMessageId);
    const rawContent = typeof payload.content === 'string' ? payload.content.trim() : '';
    const content = sanitizeChatText(rawContent);

    if (!roomId || !senderId || !content) {
      const errorPayload = { message: 'roomId, senderId y content son requeridos' };
      socket.emit('chat:error', errorPayload);
      if (typeof callback === 'function') {
        callback({ ok: false, error: errorPayload.message });
      }
      return;
    }

    if (content.length > CHAT_MAX_MESSAGE_LENGTH) {
      const errorPayload = {
        message: `El mensaje supera el maximo permitido (${CHAT_MAX_MESSAGE_LENGTH})`,
      };
      socket.emit('chat:error', errorPayload);
      if (typeof callback === 'function') {
        callback({ ok: false, error: errorPayload.message });
      }
      return;
    }

    if (!isUserInRoom(roomId, senderId)) {
      const errorPayload = { message: 'El usuario no pertenece a la sala' };
      socket.emit('chat:error', errorPayload);
      if (typeof callback === 'function') {
        callback({ ok: false, error: errorPayload.message });
      }
      return;
    }

    if (isRateLimited(roomId, senderId)) {
      const errorPayload = {
        message: 'Limite de mensajes excedido. Intenta nuevamente en unos segundos.',
      };
      socket.emit('chat:error', errorPayload);
      if (typeof callback === 'function') {
        callback({ ok: false, error: errorPayload.message, rateLimited: true });
      }
      return;
    }

    if (isDuplicateMessage(roomId, senderId, content, clientMessageId)) {
      const duplicatePayload = {
        ok: true,
        duplicate: true,
        clientMessageId: clientMessageId || null,
      };
      if (typeof callback === 'function') {
        callback(duplicatePayload);
      }
      socket.emit('chat:message-ack', duplicatePayload);
      return;
    }

    const messagePayload = {
      messageId: uuidv4(),
      clientMessageId: clientMessageId || null,
      roomId,
      senderId,
      content,
      type: 'texto',
      timestamp: new Date(),
    };

    // Persistencia opcional si Mongo está disponible
    if (mongoose.connection.readyState === 1) {
      try {
        await Message.create(messagePayload);
      } catch (error) {
        console.error('Error guardando mensaje en MongoDB:', error.message);
      }
    }

    io.to(roomId).emit('chat:receive-message', messagePayload);

    const ackPayload = {
      ok: true,
      duplicate: false,
      messageId: messagePayload.messageId,
      clientMessageId: messagePayload.clientMessageId,
      timestamp: messagePayload.timestamp,
    };

    if (typeof callback === 'function') {
      callback(ackPayload);
    }
    socket.emit('chat:message-ack', ackPayload);
  });

  socket.on('chat:leave-room', (payload) => {
    leaveRoom(socket, payload);
  });

  socket.on('webrtc:leave-room', (payload) => {
    leaveRoom(socket, payload);
  });

  // ========== EVENTOS MEDIASOUP SFU ==========
  socket.on('mediasoup:get-router-rtp-capabilities', async (payload, callback) => {
    const { roomId } = payload;
    if (!roomId) {
      return callback({ error: 'roomId es requerido' });
    }

    try {
      const router = await getOrCreateRouter(roomId);
      const rtpCapabilities = router.rtpCapabilities;
      callback({ rtpCapabilities });
    } catch (error) {
      console.error('[Mediasoup] Error obteniendo RTP capabilities:', error.message);
      callback({ error: error.message });
    }
  });

  socket.on('mediasoup:create-transport', async (payload, callback) => {
    const { roomId, userId } = payload;
    if (!roomId || !userId) {
      return callback({ error: 'roomId y userId son requeridos' });
    }

    try {
      const router = await getOrCreateRouter(roomId);
      const roomData = getRoomData(roomId);

      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: '127.0.0.1', announcedIp: undefined }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });

      // Guardar el transporte
      roomData.transports.set(socket.id, transport);

      const { id, iceParameters, iceCandidates, dtlsParameters } = transport;

      transport.on('dtlsstatechange', (dtlsState) => {
        if (dtlsState === 'failed') {
          console.warn(`[Mediasoup] DTLS failed en transporte ${id}`);
          io.to(socket.id).emit('mediasoup:error', { message: 'Conexión de transporte fallida' });
        }
      });

      transport.on('close', () => {
        console.log(`[Mediasoup] Transporte ${id} cerrado`);
      });

      callback({
        id,
        iceParameters,
        iceCandidates,
        dtlsParameters,
      });
    } catch (error) {
      console.error('[Mediasoup] Error creando transporte:', error.message);
      callback({ error: error.message });
    }
  });

  socket.on('mediasoup:connect-transport', async (payload, callback) => {
    const { roomId, dtlsParameters } = payload;
    if (!roomId || !dtlsParameters) {
      return callback({ error: 'roomId y dtlsParameters son requeridos' });
    }

    try {
      const roomData = getRoomData(roomId);
      const transport = roomData.transports.get(socket.id);
      if (!transport) {
        return callback({ error: 'Transporte no encontrado' });
      }

      await transport.connect({ dtlsParameters });
      callback({ ok: true });
    } catch (error) {
      console.error('[Mediasoup] Error conectando transporte:', error.message);
      callback({ error: error.message });
    }
  });

  socket.on('mediasoup:produce', async (payload, callback) => {
    const { roomId, userId, kind, rtpParameters } = payload;
    if (!roomId || !userId || !kind || !rtpParameters) {
      return callback({ error: 'roomId, userId, kind y rtpParameters son requeridos' });
    }

    try {
      const roomData = getRoomData(roomId);
      const transport = roomData.transports.get(socket.id);
      if (!transport) {
        return callback({ error: 'Transporte no encontrado' });
      }

      const producer = await transport.produce({
        kind,
        rtpParameters,
      });

      // Guardar el productor
      if (!roomData.producers.has(userId)) {
        roomData.producers.set(userId, {});
      }
      roomData.producers.get(userId)[kind] = producer;

      console.log(`[Mediasoup] Productor ${kind} creado para usuario ${userId} en sala ${roomId}`);

      // Notificar a otros usuarios que hay un nuevo productor
      socket.to(roomId).emit('mediasoup:producer-added', {
        userId,
        kind,
        producerId: producer.id,
      });

      callback({
        id: producer.id,
        ok: true,
      });
    } catch (error) {
      console.error('[Mediasoup] Error creando productor:', error.message);
      callback({ error: error.message });
    }
  });

  socket.on('mediasoup:consume', async (payload, callback) => {
    const { roomId, userId, producerId, rtpCapabilities } = payload;
    if (!roomId || !userId || !producerId || !rtpCapabilities) {
      return callback({ error: 'roomId, userId, producerId y rtpCapabilities son requeridos' });
    }

    try {
      const roomData = getRoomData(roomId);
      const router = roomData.router;

      // Buscar el productor
      let producer = null;
      for (const [prodUserId, producers] of roomData.producers) {
        for (const [kind, prod] of Object.entries(producers)) {
          if (prod.id === producerId) {
            producer = prod;
            break;
          }
        }
        if (producer) break;
      }

      if (!producer) {
        return callback({ error: 'Productor no encontrado' });
      }

      // Verificar si el router puede consumir el productor
      if (!router.canConsume({ producerId, rtpCapabilities })) {
        return callback({ error: 'No se puede consumir este productor' });
      }

      const transport = roomData.transports.get(socket.id);
      if (!transport) {
        return callback({ error: 'Transporte no encontrado' });
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: false,
      });

      // Guardar el consumidor
      if (!roomData.consumers.has(userId)) {
        roomData.consumers.set(userId, new Map());
      }
      roomData.consumers.get(userId).set(producerId, consumer);

      console.log(`[Mediasoup] Consumidor creado para usuario ${userId} -> productor ${producerId}`);

      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        ok: true,
      });
    } catch (error) {
      console.error('[Mediasoup] Error creando consumidor:', error.message);
      callback({ error: error.message });
    }
  });

  socket.on('mediasoup:close-consumer', async (payload, callback) => {
    const { roomId, userId, consumerId } = payload;
    if (!roomId || !userId || !consumerId) {
      return callback({ error: 'roomId, userId y consumerId son requeridos' });
    }

    try {
      const roomData = getRoomData(roomId);
      const consumers = roomData.consumers.get(userId);
      if (!consumers) {
        return callback({ error: 'No hay consumidores para este usuario' });
      }

      for (const [prodId, consumer] of consumers) {
        if (consumer.id === consumerId) {
          await consumer.close();
          consumers.delete(prodId);
          console.log(`[Mediasoup] Consumidor ${consumerId} cerrado`);
          return callback({ ok: true });
        }
      }

      callback({ error: 'Consumidor no encontrado' });
    } catch (error) {
      console.error('[Mediasoup] Error cerrando consumidor:', error.message);
      callback({ error: error.message });
    }
  });
  // ========== FIN EVENTOS MEDIASOUP ==========

  socket.on('disconnect', () => {
    console.log(`[Socket.IO] Cliente desconectado: ${socket.id}`);

    // Limpiar recursos de mediasoup
    const roomId = socket.data.roomId;
    if (roomId) {
      const roomData = getRoomData(roomId);
      if (roomData) {
        const transport = roomData.transports.get(socket.id);
        if (transport) {
          transport.close().catch(() => {});
          roomData.transports.delete(socket.id);
        }
      }

      // Si la sala está vacía, limpiarla
      const participants = getRoomParticipants(roomId);
      if (participants.length === 0) {
        cleanupRoom(roomId);
      }
    }

    leaveRoom(socket, {}, false);
  });

  // Eventos de prueba
  socket.on('ping', (callback) => {
    callback({ pong: true, timestamp: new Date().toISOString() });
  });
});

// Puerto y servidor
const PORT = process.env.PORT || 8082;

// Conexión opcional a MongoDB (si falla, el chat tiempo real sigue funcionando)
if (process.env.DATABASE_URL) {
  mongoose
    .connect(process.env.DATABASE_URL)
    .then(() => {
      console.log('MongoDB conectado');
    })
    .catch((error) => {
      console.warn(`MongoDB no disponible: ${error.message}`);
    });
}

// Inicializar Mediasoup y luego iniciar el servidor
(async () => {
  try {
    await initMediasoup();
    console.log('[Mediasoup] Worker inicializado exitosamente');
  } catch (error) {
    console.error('[Mediasoup] No se pudo inicializar el worker:', error);
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(` VideoChatService (SFU) ejecutando en puerto ${PORT}`);
    console.log(` Arquitectura: Selective Forwarding Unit (Mediasoup)`);
    console.log(` WebSocket (Socket.IO) disponible`);
    console.log(` CORS habilitado para: ${process.env.CORS_ORIGIN}`);
  });
})();

// Manejo de errores no capturados
process.on('unhandledRejection', (err) => {
  console.error(' Unhandled Rejection:', err);
});

module.exports = { app, server, io };
