const mongoose = require('mongoose');

const EnrollmentSchema = new mongoose.Schema(
  {
    patientId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ['REGISTERED', 'JOINED', 'LEFT'],
      default: 'REGISTERED',
      required: true,
    },
    enrolledAt: { type: Date, default: Date.now },
    joinedAt: { type: Date, default: null },
    leftAt: { type: Date, default: null },
  },
  { _id: false }
);

const GroupEventSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, required: true, trim: true, maxlength: 1000 },
    psychologistId: { type: String, required: true, index: true },
    psychologistName: { type: String, default: '' },
    scheduledStart: { type: Date, required: true, index: true },
    scheduledEnd: { type: Date, required: true },
    status: {
      type: String,
      enum: ['SCHEDULED', 'LIVE', 'FINISHED', 'CANCELLED'],
      default: 'SCHEDULED',
      required: true,
      index: true,
    },
    capacity: { type: Number, default: 30, min: 2, max: 500 },
    audience: {
      type: String,
      enum: ['ALL_PATIENTS'],
      default: 'ALL_PATIENTS',
      required: true,
    },
    roomId: { type: String, default: null },
    createdBy: { type: String, default: '' },
    enrollments: { type: [EnrollmentSchema], default: [] },
  },
  {
    timestamps: true,
  }
);

GroupEventSchema.index({ psychologistId: 1, scheduledStart: -1 });
GroupEventSchema.index({ status: 1, scheduledStart: -1 });

module.exports = mongoose.model('GroupEvent', GroupEventSchema);
