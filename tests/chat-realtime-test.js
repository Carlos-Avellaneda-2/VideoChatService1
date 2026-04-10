/* eslint-disable no-console */
const { io } = require('socket.io-client');

const SERVER_URL = process.env.TEST_SERVER_URL || 'http://localhost:3000';
const ROOM_ID = `chat-room-${Date.now()}`;

function createClient(userId, role) {
  const socket = io(SERVER_URL, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000,
  });

  return { socket, userId, role };
}

function waitForEvent(socket, eventName, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, onEvent);
      reject(new Error(`Timeout esperando evento ${eventName}`));
    }, timeoutMs);

    function onEvent(payload) {
      clearTimeout(timeout);
      resolve(payload);
    }

    socket.once(eventName, onEvent);
  });
}

function emitWithAck(socket, eventName, payload, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout esperando ACK de ${eventName}`));
    }, timeoutMs);

    socket.emit(eventName, payload, (ack) => {
      clearTimeout(timeout);
      resolve(ack);
    });
  });
}

async function run() {
  const alice = createClient('alice-chat', 'psicologo');
  const bob = createClient('bob-chat', 'paciente');
  const outsider = createClient('outsider-chat', 'paciente');

  try {
    await Promise.all([
      waitForEvent(alice.socket, 'connect'),
      waitForEvent(bob.socket, 'connect'),
      waitForEvent(outsider.socket, 'connect'),
    ]);

    alice.socket.emit('chat:join-room', {
      roomId: ROOM_ID,
      userId: alice.userId,
      role: alice.role,
    });

    bob.socket.emit('chat:join-room', {
      roomId: ROOM_ID,
      userId: bob.userId,
      role: bob.role,
    });

    await Promise.all([
      waitForEvent(alice.socket, 'chat:participants'),
      waitForEvent(bob.socket, 'chat:participants'),
    ]);

    const bobReceivePromise = waitForEvent(bob.socket, 'chat:receive-message');
    const ack = await emitWithAck(alice.socket, 'chat:send-message', {
      roomId: ROOM_ID,
      senderId: alice.userId,
      content: '<b>Hola Bob</b>',
      clientMessageId: 'msg-1',
    });

    if (!ack || !ack.ok || !ack.messageId) {
      throw new Error('ACK invalido al enviar mensaje normal');
    }

    const messageOnBob = await bobReceivePromise;
    if (messageOnBob.content !== '&lt;b&gt;Hola Bob&lt;/b&gt;') {
      throw new Error('El mensaje no fue sanitizado correctamente');
    }

    const duplicateAck = await emitWithAck(alice.socket, 'chat:send-message', {
      roomId: ROOM_ID,
      senderId: alice.userId,
      content: '<b>Hola Bob</b>',
      clientMessageId: 'msg-1',
    });

    if (!duplicateAck || !duplicateAck.ok || !duplicateAck.duplicate) {
      throw new Error('No se detecto el mensaje duplicado');
    }

    const outsiderErrorPromise = waitForEvent(outsider.socket, 'chat:error');
    await emitWithAck(outsider.socket, 'chat:send-message', {
      roomId: ROOM_ID,
      senderId: outsider.userId,
      content: 'No pertenezco a la sala',
    });

    const outsiderError = await outsiderErrorPromise;
    if (!outsiderError.message.includes('no pertenece')) {
      throw new Error('No se valido membresia de sala en chat');
    }

    let rateLimitedDetected = false;
    for (let i = 0; i < 8; i += 1) {
      const spamAck = await emitWithAck(bob.socket, 'chat:send-message', {
        roomId: ROOM_ID,
        senderId: bob.userId,
        content: `spam-${i}-${Date.now()}`,
        clientMessageId: `spam-msg-${i}`,
      });

      if (spamAck && spamAck.rateLimited) {
        rateLimitedDetected = true;
        break;
      }
    }

    if (!rateLimitedDetected) {
      throw new Error('No se activo el rate limit de chat');
    }

    console.log('OK: chat robusto validado (sanitizacion, dedupe, membresia, rate limit, ACK)');
  } finally {
    alice.socket.disconnect();
    bob.socket.disconnect();
    outsider.socket.disconnect();
  }
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(`ERROR pruebas Chat: ${error.message}`);
    process.exitCode = 1;
  });
