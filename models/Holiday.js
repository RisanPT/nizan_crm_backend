/**
 * Holiday — a paid company holiday on the calendar. Drives the Leave calendar
 * and (later) excludes holidays from the leave-day count.
 */
import mongoose from 'mongoose';

export const HOLIDAY_TYPES = ['national', 'regional', 'optional', 'company'];

const holidaySchema = mongoose.Schema(
  {
    name: { type: String, required: [true, 'Holiday name is required'], trim: true },
    date: { type: Date, required: true },
    year: { type: Number },
    type: { type: String, enum: HOLIDAY_TYPES, default: 'national' },
    recurring: { type: Boolean, default: false },
    notes: { type: String, default: '' },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

holidaySchema.index({ date: 1 });
holidaySchema.index({ year: 1 });

export default mongoose.model('Holiday', holidaySchema);
