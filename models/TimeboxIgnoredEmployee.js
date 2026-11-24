import mongoose from 'mongoose';

// A Timebox person HR deleted from the CRM (2026-11-24). The Timebox employee
// sync never re-creates them. Removing the row lets the next HR sync import
// them again.
const timeboxIgnoredEmployeeSchema = new mongoose.Schema(
  {
    timeboxEmployeeId: { type: Number, required: true, unique: true },
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const TimeboxIgnoredEmployee = mongoose.model('TimeboxIgnoredEmployee', timeboxIgnoredEmployeeSchema);
export default TimeboxIgnoredEmployee;
