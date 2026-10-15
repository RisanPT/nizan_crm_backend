import mongoose from 'mongoose';

// A named work shift (window + grace). Informational: it sets the attendance
// expectation that Timebox-derived punches are read against. workingDays uses
// 0=Sun … 6=Sat.
const shiftSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true, default: '' },
    startTime: { type: String, default: '09:00' }, // "HH:mm"
    endTime: { type: String, default: '18:00' },
    graceInMin: { type: Number, default: 10 },
    graceOutMin: { type: Number, default: 10 },
    workingDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] },
    color: { type: String, default: '#601A29' },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const Shift = mongoose.model('Shift', shiftSchema);
export default Shift;
