const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const GroupEvent = require('../models/GroupEvent');

class GroupEventStoreError extends Error {
  constructor(message, status = 400, code = 'EVENT_STORE_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const inMemoryEvents = new Map();

const ACTIVE_ENROLLMENT_STATUSES = new Set(['REGISTERED', 'JOINED']);

function isDatabaseReady() {
  return mongoose.connection.readyState === 1;
}

function toIso(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function mapEnrollment(enrollment) {
  return {
    patientId: String(enrollment.patientId || ''),
    status: String(enrollment.status || 'REGISTERED').toUpperCase(),
    enrolledAt: toIso(enrollment.enrolledAt),
    joinedAt: toIso(enrollment.joinedAt),
    leftAt: toIso(enrollment.leftAt),
  };
}

function mapEvent(raw) {
  const source = raw.toObject ? raw.toObject() : raw;
  const id = String(source._id || source.id);
  const enrollments = Array.isArray(source.enrollments) ? source.enrollments.map(mapEnrollment) : [];
  const enrolledCount = enrollments.filter((item) => ACTIVE_ENROLLMENT_STATUSES.has(item.status)).length;

  return {
    id,
    title: String(source.title || ''),
    description: String(source.description || ''),
    psychologistId: String(source.psychologistId || ''),
    psychologistName: source.psychologistName ? String(source.psychologistName) : undefined,
    scheduledStart: toIso(source.scheduledStart),
    scheduledEnd: toIso(source.scheduledEnd),
    status: String(source.status || 'SCHEDULED').toUpperCase(),
    capacity: Number(source.capacity || 30),
    audience: String(source.audience || 'ALL_PATIENTS'),
    roomId: source.roomId ? String(source.roomId) : undefined,
    createdBy: source.createdBy ? String(source.createdBy) : undefined,
    createdAt: toIso(source.createdAt),
    updatedAt: toIso(source.updatedAt),
    enrolledCount,
    enrollments,
  };
}

function validateDateRange(scheduledStart, scheduledEnd) {
  const startDate = new Date(scheduledStart);
  const endDate = new Date(scheduledEnd);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new GroupEventStoreError('Las fechas del evento no son válidas.', 400, 'INVALID_DATE');
  }

  if (endDate.getTime() <= startDate.getTime()) {
    throw new GroupEventStoreError('La fecha de fin debe ser mayor a la fecha de inicio.', 400, 'INVALID_DATE_RANGE');
  }
}

function validateCapacity(capacity) {
  const numericCapacity = Number(capacity);
  if (!Number.isFinite(numericCapacity) || numericCapacity < 2 || numericCapacity > 500) {
    throw new GroupEventStoreError('La capacidad debe estar entre 2 y 500.', 400, 'INVALID_CAPACITY');
  }
  return numericCapacity;
}

function filterEvents(events, filters = {}) {
  return events.filter((event) => {
    if (filters.psychologistId && String(event.psychologistId) !== String(filters.psychologistId)) {
      return false;
    }

    if (Array.isArray(filters.statuses) && filters.statuses.length > 0) {
      if (!filters.statuses.includes(String(event.status).toUpperCase())) {
        return false;
      }
    }

    if (filters.onlyVisibleToPatients) {
      const visibleStatuses = new Set(['SCHEDULED', 'LIVE']);
      if (!visibleStatuses.has(String(event.status).toUpperCase())) {
        return false;
      }
    }

    return true;
  });
}

function sortByScheduledStartDesc(events) {
  return events.sort((a, b) => new Date(b.scheduledStart).getTime() - new Date(a.scheduledStart).getTime());
}

async function createEvent(payload) {
  const title = String(payload.title || '').trim();
  const description = String(payload.description || '').trim();
  const psychologistId = String(payload.psychologistId || '').trim();

  if (!title) {
    throw new GroupEventStoreError('El título es obligatorio.', 400, 'MISSING_TITLE');
  }

  if (!description) {
    throw new GroupEventStoreError('La descripción es obligatoria.', 400, 'MISSING_DESCRIPTION');
  }

  if (!psychologistId) {
    throw new GroupEventStoreError('psychologistId es obligatorio.', 400, 'MISSING_PSYCHOLOGIST_ID');
  }

  validateDateRange(payload.scheduledStart, payload.scheduledEnd);
  const capacity = validateCapacity(payload.capacity);

  const normalized = {
    title,
    description,
    psychologistId,
    psychologistName: payload.psychologistName ? String(payload.psychologistName).trim() : '',
    scheduledStart: new Date(payload.scheduledStart),
    scheduledEnd: new Date(payload.scheduledEnd),
    status: 'SCHEDULED',
    capacity,
    audience: 'ALL_PATIENTS',
    roomId: payload.roomId ? String(payload.roomId) : null,
    createdBy: payload.createdBy ? String(payload.createdBy) : '',
    enrollments: [],
  };

  if (isDatabaseReady()) {
    const doc = await GroupEvent.create(normalized);
    return mapEvent(doc);
  }

  const id = uuidv4();
  const now = new Date();
  const inMemoryEvent = {
    ...normalized,
    id,
    createdAt: now,
    updatedAt: now,
  };
  inMemoryEvents.set(id, inMemoryEvent);

  return mapEvent(inMemoryEvent);
}

async function listEvents(filters = {}) {
  if (isDatabaseReady()) {
    const query = {};

    if (filters.psychologistId) {
      query.psychologistId = String(filters.psychologistId);
    }

    if (Array.isArray(filters.statuses) && filters.statuses.length > 0) {
      query.status = { $in: filters.statuses.map((item) => String(item).toUpperCase()) };
    }

    if (filters.onlyVisibleToPatients) {
      query.status = { $in: ['SCHEDULED', 'LIVE'] };
    }

    const docs = await GroupEvent.find(query).sort({ scheduledStart: -1 }).lean();
    return docs.map(mapEvent);
  }

  const events = Array.from(inMemoryEvents.values()).map(mapEvent);
  return sortByScheduledStartDesc(filterEvents(events, filters));
}

async function getEventById(eventId) {
  const normalizedId = String(eventId || '').trim();
  if (!normalizedId) {
    return null;
  }

  if (isDatabaseReady()) {
    if (!mongoose.Types.ObjectId.isValid(normalizedId)) {
      return null;
    }

    const doc = await GroupEvent.findById(normalizedId);
    return doc ? mapEvent(doc) : null;
  }

  const event = inMemoryEvents.get(normalizedId);
  return event ? mapEvent(event) : null;
}

async function updateEventStatus(eventId, nextStatus, options = {}) {
  const normalizedId = String(eventId || '').trim();
  const normalizedStatus = String(nextStatus || '').toUpperCase();
  const allowedFrom = Array.isArray(options.allowedFrom)
    ? options.allowedFrom.map((status) => String(status).toUpperCase())
    : [];

  if (!normalizedId) {
    throw new GroupEventStoreError('El id del evento es obligatorio.', 400, 'MISSING_EVENT_ID');
  }

  if (!normalizedStatus) {
    throw new GroupEventStoreError('El estado de destino es obligatorio.', 400, 'MISSING_STATUS');
  }

  if (isDatabaseReady()) {
    if (!mongoose.Types.ObjectId.isValid(normalizedId)) {
      throw new GroupEventStoreError('Evento no encontrado.', 404, 'EVENT_NOT_FOUND');
    }

    const doc = await GroupEvent.findById(normalizedId);
    if (!doc) {
      throw new GroupEventStoreError('Evento no encontrado.', 404, 'EVENT_NOT_FOUND');
    }

    const currentStatus = String(doc.status || '').toUpperCase();
    if (allowedFrom.length > 0 && !allowedFrom.includes(currentStatus)) {
      throw new GroupEventStoreError(
        `No se puede pasar de ${currentStatus} a ${normalizedStatus}.`,
        409,
        'INVALID_STATUS_TRANSITION'
      );
    }

    doc.status = normalizedStatus;
    if (options.roomId) {
      doc.roomId = String(options.roomId);
    }

    await doc.save();
    return mapEvent(doc);
  }

  const existing = inMemoryEvents.get(normalizedId);
  if (!existing) {
    throw new GroupEventStoreError('Evento no encontrado.', 404, 'EVENT_NOT_FOUND');
  }

  const currentStatus = String(existing.status || '').toUpperCase();
  if (allowedFrom.length > 0 && !allowedFrom.includes(currentStatus)) {
    throw new GroupEventStoreError(
      `No se puede pasar de ${currentStatus} a ${normalizedStatus}.`,
      409,
      'INVALID_STATUS_TRANSITION'
    );
  }

  existing.status = normalizedStatus;
  if (options.roomId) {
    existing.roomId = String(options.roomId);
  }
  existing.updatedAt = new Date();
  inMemoryEvents.set(normalizedId, existing);

  return mapEvent(existing);
}

function activeEnrollmentCount(enrollments) {
  return enrollments.filter((item) => ACTIVE_ENROLLMENT_STATUSES.has(String(item.status || '').toUpperCase())).length;
}

async function enrollPatient(eventId, patientId) {
  const normalizedEventId = String(eventId || '').trim();
  const normalizedPatientId = String(patientId || '').trim();

  if (!normalizedEventId || !normalizedPatientId) {
    throw new GroupEventStoreError('eventId y patientId son requeridos.', 400, 'MISSING_ENROLL_FIELDS');
  }

  if (isDatabaseReady()) {
    if (!mongoose.Types.ObjectId.isValid(normalizedEventId)) {
      throw new GroupEventStoreError('Evento no encontrado.', 404, 'EVENT_NOT_FOUND');
    }

    const doc = await GroupEvent.findById(normalizedEventId);
    if (!doc) {
      throw new GroupEventStoreError('Evento no encontrado.', 404, 'EVENT_NOT_FOUND');
    }

    const status = String(doc.status || '').toUpperCase();
    if (!['SCHEDULED', 'LIVE'].includes(status)) {
      throw new GroupEventStoreError('No se puede inscribir en un evento no disponible.', 409, 'EVENT_NOT_OPEN');
    }

    const enrollment = doc.enrollments.find((item) => String(item.patientId) === normalizedPatientId);
    if (enrollment && ACTIVE_ENROLLMENT_STATUSES.has(String(enrollment.status || '').toUpperCase())) {
      return mapEvent(doc);
    }

    const currentCount = activeEnrollmentCount(doc.enrollments);
    if (!enrollment && currentCount >= Number(doc.capacity || 0)) {
      throw new GroupEventStoreError('El evento alcanzó su capacidad máxima.', 409, 'EVENT_FULL');
    }

    if (enrollment) {
      enrollment.status = 'REGISTERED';
      enrollment.leftAt = null;
    } else {
      doc.enrollments.push({
        patientId: normalizedPatientId,
        status: 'REGISTERED',
        enrolledAt: new Date(),
      });
    }

    await doc.save();
    return mapEvent(doc);
  }

  const event = inMemoryEvents.get(normalizedEventId);
  if (!event) {
    throw new GroupEventStoreError('Evento no encontrado.', 404, 'EVENT_NOT_FOUND');
  }

  const status = String(event.status || '').toUpperCase();
  if (!['SCHEDULED', 'LIVE'].includes(status)) {
    throw new GroupEventStoreError('No se puede inscribir en un evento no disponible.', 409, 'EVENT_NOT_OPEN');
  }

  event.enrollments = Array.isArray(event.enrollments) ? event.enrollments : [];
  const enrollment = event.enrollments.find((item) => String(item.patientId) === normalizedPatientId);

  if (enrollment && ACTIVE_ENROLLMENT_STATUSES.has(String(enrollment.status || '').toUpperCase())) {
    return mapEvent(event);
  }

  const currentCount = activeEnrollmentCount(event.enrollments);
  if (!enrollment && currentCount >= Number(event.capacity || 0)) {
    throw new GroupEventStoreError('El evento alcanzó su capacidad máxima.', 409, 'EVENT_FULL');
  }

  if (enrollment) {
    enrollment.status = 'REGISTERED';
    enrollment.leftAt = null;
    enrollment.enrolledAt = enrollment.enrolledAt || new Date();
  } else {
    event.enrollments.push({
      patientId: normalizedPatientId,
      status: 'REGISTERED',
      enrolledAt: new Date(),
      joinedAt: null,
      leftAt: null,
    });
  }

  event.updatedAt = new Date();
  inMemoryEvents.set(normalizedEventId, event);
  return mapEvent(event);
}

async function leaveEvent(eventId, patientId) {
  const normalizedEventId = String(eventId || '').trim();
  const normalizedPatientId = String(patientId || '').trim();

  if (!normalizedEventId || !normalizedPatientId) {
    throw new GroupEventStoreError('eventId y patientId son requeridos.', 400, 'MISSING_ENROLL_FIELDS');
  }

  if (isDatabaseReady()) {
    if (!mongoose.Types.ObjectId.isValid(normalizedEventId)) {
      throw new GroupEventStoreError('Evento no encontrado.', 404, 'EVENT_NOT_FOUND');
    }

    const doc = await GroupEvent.findById(normalizedEventId);
    if (!doc) {
      throw new GroupEventStoreError('Evento no encontrado.', 404, 'EVENT_NOT_FOUND');
    }

    const enrollment = doc.enrollments.find((item) => String(item.patientId) === normalizedPatientId);
    if (!enrollment) {
      throw new GroupEventStoreError('No existe inscripción para este paciente.', 404, 'ENROLLMENT_NOT_FOUND');
    }

    enrollment.status = 'LEFT';
    enrollment.leftAt = new Date();

    await doc.save();
    return mapEvent(doc);
  }

  const event = inMemoryEvents.get(normalizedEventId);
  if (!event) {
    throw new GroupEventStoreError('Evento no encontrado.', 404, 'EVENT_NOT_FOUND');
  }

  const enrollment = Array.isArray(event.enrollments)
    ? event.enrollments.find((item) => String(item.patientId) === normalizedPatientId)
    : null;

  if (!enrollment) {
    throw new GroupEventStoreError('No existe inscripción para este paciente.', 404, 'ENROLLMENT_NOT_FOUND');
  }

  enrollment.status = 'LEFT';
  enrollment.leftAt = new Date();
  event.updatedAt = new Date();
  inMemoryEvents.set(normalizedEventId, event);

  return mapEvent(event);
}

module.exports = {
  GroupEventStoreError,
  createEvent,
  listEvents,
  getEventById,
  updateEventStatus,
  enrollPatient,
  leaveEvent,
};
