/* eslint-disable no-console */
const jwt = require('jsonwebtoken');
const DEFAULT_BASE_URL = process.env.TEST_SERVER_URL || 'http://localhost:8082';

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(baseUrl, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // ignore transient connection errors while booting.
    }

    await sleep(300);
  }

  throw new Error('El servidor no respondió /health dentro del tiempo esperado.');
}

async function requestJson(baseUrl, method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }

  return { status: response.status, payload };
}

async function run() {
  const baseUrl = DEFAULT_BASE_URL;
  await waitForHealth(baseUrl);

  const jwtSecret = process.env.JWT_SECRET || 'test-secret-events';
  const adminToken = jwt.sign({ userId: 'admin-1', role: 'ADMIN' }, jwtSecret, { expiresIn: '1h' });
  const psychToken = jwt.sign({ userId: 'psych-1', role: 'PSYCHOLOGIST' }, jwtSecret, { expiresIn: '1h' });
  const outsiderPsychToken = jwt.sign({ userId: 'psych-2', role: 'PSYCHOLOGIST' }, jwtSecret, { expiresIn: '1h' });
  const patientToken = jwt.sign({ userId: 'patient-1', role: 'PATIENT' }, jwtSecret, { expiresIn: '1h' });

  const createPayload = {
    title: `Evento QA ${Date.now()}`,
    description: 'Sesión grupal para validar flujo end-to-end.',
    psychologistId: 'psych-1',
    psychologistName: 'Psicologo QA',
    scheduledStart: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    scheduledEnd: new Date(Date.now() + 70 * 60 * 1000).toISOString(),
    capacity: 25,
  };

  const unauthorizedCreate = await requestJson(baseUrl, 'POST', '/api/events', null, createPayload);
  assertCondition(unauthorizedCreate.status === 401, 'POST /api/events sin token debe responder 401.');

  const forbiddenCreate = await requestJson(baseUrl, 'POST', '/api/events', psychToken, createPayload);
  assertCondition(forbiddenCreate.status === 403, 'POST /api/events con psicólogo debe responder 403.');

  const created = await requestJson(baseUrl, 'POST', '/api/events', adminToken, createPayload);
  assertCondition(created.status === 201, 'POST /api/events con admin debe responder 201.');
  assertCondition(created.payload && created.payload.id, 'El evento creado debe retornar id.');
  assertCondition(created.payload.status === 'SCHEDULED', 'El evento nuevo debe iniciar en estado SCHEDULED.');

  const eventId = created.payload.id;

  const adminList = await requestJson(baseUrl, 'GET', '/api/events', adminToken);
  assertCondition(adminList.status === 200, 'GET /api/events debe responder 200 para admin.');
  assertCondition(Array.isArray(adminList.payload) && adminList.payload.some((item) => item.id === eventId), 'El evento creado debe aparecer en listado admin.');

  const psychAgenda = await requestJson(baseUrl, 'GET', '/api/events/psychologist/agenda', psychToken);
  assertCondition(psychAgenda.status === 200, 'GET agenda psicólogo debe responder 200.');
  assertCondition(Array.isArray(psychAgenda.payload) && psychAgenda.payload.some((item) => item.id === eventId), 'El evento debe aparecer en agenda del psicólogo dueño.');

  const startForbidden = await requestJson(baseUrl, 'POST', `/api/events/${eventId}/start`, outsiderPsychToken);
  assertCondition(startForbidden.status === 403, 'Un psicólogo distinto no puede iniciar el evento.');

  const started = await requestJson(baseUrl, 'POST', `/api/events/${eventId}/start`, psychToken);
  assertCondition(started.status === 200, 'El psicólogo dueño debe poder iniciar el evento.');
  assertCondition(started.payload.status === 'LIVE', 'El evento debe pasar a estado LIVE.');
  assertCondition(Boolean(started.payload.roomId), 'Al iniciar evento debe existir roomId.');

  const patientOffers = await requestJson(baseUrl, 'GET', '/api/events/patient/offers', patientToken);
  assertCondition(patientOffers.status === 200, 'GET ofertas paciente debe responder 200.');
  assertCondition(Array.isArray(patientOffers.payload) && patientOffers.payload.some((item) => item.id === eventId), 'El evento LIVE debe ser visible en ofertas de paciente.');

  const enrolled = await requestJson(baseUrl, 'POST', `/api/events/${eventId}/enroll`, patientToken);
  assertCondition(enrolled.status === 200, 'Paciente debe poder inscribirse.');
  assertCondition(enrolled.payload.isEnrolled === true, 'Respuesta de inscripción debe marcar isEnrolled=true.');

  const left = await requestJson(baseUrl, 'DELETE', `/api/events/${eventId}/enrollments/me`, patientToken);
  assertCondition(left.status === 200, 'Paciente debe poder salir del evento.');
  assertCondition(left.payload.enrollmentStatus === 'LEFT', 'Al salir del evento el estado de inscripción debe ser LEFT.');

  const finished = await requestJson(baseUrl, 'POST', `/api/events/${eventId}/finish`, psychToken);
  assertCondition(finished.status === 200, 'El psicólogo dueño debe poder finalizar el evento.');
  assertCondition(finished.payload.status === 'FINISHED', 'El evento debe pasar a FINISHED.');

  const cancelAfterFinish = await requestJson(baseUrl, 'POST', `/api/events/${eventId}/cancel`, psychToken);
  assertCondition(cancelAfterFinish.status === 409, 'No se debe poder cancelar un evento ya finalizado.');

  console.log('OK: API de eventos validada (autorización, ciclo de vida, ofertas e inscripción).');
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(`ERROR pruebas Event API: ${error.message}`);
    process.exitCode = 1;
  });
