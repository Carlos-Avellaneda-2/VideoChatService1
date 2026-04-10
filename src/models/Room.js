const mongoose = require('mongoose');

const RoomSchema = new mongoose.Schema({
  name: { type: String, required: true },
  type: { type: String, enum: ['grupo', 'privado'], default: 'grupo' },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  maxParticipants: { type: Number, default: 100, min: 1, max: 500 },
  eventId: { type: String, index: true },
  eventType: { type: String, enum: ['GROUP_EVENT', 'APPOINTMENT'], default: null },
  eventStatus: { type: String, enum: ['SCHEDULED', 'LIVE', 'FINISHED', 'CANCELLED'], default: null },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Room', RoomSchema);