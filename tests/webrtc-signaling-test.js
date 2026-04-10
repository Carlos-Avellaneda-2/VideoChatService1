/* eslint-disable no-console */
const { io } = require('socket.io-client');

const SERVER_URL = process.env.TEST_SERVER_URL || 'http://localhost:3000';
const ROOM_ID = `room-${Date.now()}`;

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

async function run() {
  const alice = createClient('alice', 'psicologo');
  const bob = createClient('bob', 'paciente');

  try {
    await Promise.all([
      waitForEvent(alice.socket, 'connect'),
      waitForEvent(bob.socket, 'connect'),
    ]);

    const aliceParticipantsPromise = waitForEvent(alice.socket, 'webrtc:participants');
    alice.socket.emit('webrtc:join-room', {
      roomId: ROOM_ID,
      userId: alice.userId,
      role: alice.role,
    });

    await aliceParticipantsPromise;

    const aliceUserJoinedPromise = waitForEvent(alice.socket, 'webrtc:user-joined');
    const bobExistingPromise = waitForEvent(bob.socket, 'webrtc:existing-participants');

    bob.socket.emit('webrtc:join-room', {
      roomId: ROOM_ID,
      userId: bob.userId,
      role: bob.role,
    });

    const [aliceUserJoined, bobExisting] = await Promise.all([
      aliceUserJoinedPromise,
      bobExistingPromise,
    ]);

    if (aliceUserJoined.user.userId !== 'bob') {
      throw new Error('alice no recibió el user-joined de bob');
    }

    const hasAlice = bobExisting.participants.some((p) => p.userId === 'alice');
    if (!hasAlice) {
      throw new Error('bob no recibió la lista de participantes existentes');
    }

    const bobOfferPromise = waitForEvent(bob.socket, 'webrtc:offer');
    alice.socket.emit('webrtc:offer', {
      roomId: ROOM_ID,
      senderId: 'alice',
      targetUserId: 'bob',
      sdp: { type: 'offer', sdp: 'fake-offer' },
    });

    const offerOnBob = await bobOfferPromise;
    if (offerOnBob.senderId !== 'alice') {
      throw new Error('bob no recibió correctamente el offer de alice');
    }

    const aliceAnswerPromise = waitForEvent(alice.socket, 'webrtc:answer');
    bob.socket.emit('webrtc:answer', {
      roomId: ROOM_ID,
      senderId: 'bob',
      targetUserId: 'alice',
      sdp: { type: 'answer', sdp: 'fake-answer' },
    });

    const answerOnAlice = await aliceAnswerPromise;
    if (answerOnAlice.senderId !== 'bob') {
      throw new Error('alice no recibió correctamente el answer de bob');
    }

    const bobIcePromise = waitForEvent(bob.socket, 'webrtc:ice-candidate');
    alice.socket.emit('webrtc:ice-candidate', {
      roomId: ROOM_ID,
      senderId: 'alice',
      targetUserId: 'bob',
      candidate: { candidate: 'fake-candidate' },
    });

    const iceOnBob = await bobIcePromise;
    if (iceOnBob.senderId !== 'alice') {
      throw new Error('bob no recibió correctamente ICE de alice');
    }

    console.log('OK: señalización WebRTC validada (join, offer, answer, ICE)');
  } finally {
    alice.socket.disconnect();
    bob.socket.disconnect();
  }
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(`ERROR pruebas WebRTC: ${error.message}`);
    process.exitCode = 1;
  });
