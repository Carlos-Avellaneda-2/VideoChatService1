const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  messageId: { type: String, index: true },
  clientMessageId: { type: String },
  roomId: { type: String, required: true, index: true },
  senderId: { type: String, required: true, index: true },
  content: { type: String, required: true },
  type: { type: String, enum: ['texto', 'archivo'], default: 'texto' },
  timestamp: { type: Date, default: Date.now, index: true }
});

module.exports = mongoose.model('Message', MessageSchema);