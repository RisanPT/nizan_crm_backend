import mongoose from 'mongoose';

// The smart booking allocation's settings (one record — services/allocationSettings.js). The rules are utils/artistAllocation.js.
//   mode       off → nothing changes; shadow → the ERP quietly notes what it would suggest; suggest → coordinators get suggestions
//   autoAllocate  on → right after a NEW booking is confirmed, each package goes to the top team when the match is clean (the rest wait
//              on the Allocation Board for CRM) — only with mode suggest
//   liveSince  the moment suggest was first switched on: only bookings confirmed / created after it get the allocation (the ones
//              before keep their artists as they are — they still count as her busy time)
const allocationSettingsSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: 'allocation', unique: true },
    mode: { type: String, enum: ['off', 'shadow', 'suggest'], default: 'off' },
    guard: { type: String, enum: ['off', 'on'], default: 'off' },
    autoAllocate: { type: String, enum: ['off', 'on'], default: 'off' },
    liveSince: { type: Date, default: null },
    shadowSince: { type: Date, default: null },
    eveningCutoff: { type: String, default: '14:00' },
    travelLimitMin: { type: Number, default: 30 },
    readyBufferMin: { type: Number, default: 30 },
    defaultJobMin: { type: Number, default: 180 },
    unknownTravelMin: { type: Number, default: 90 },
    eveningAssumedStart: { type: String, default: '16:00' },
    extrasPerDay: { type: Number, default: 2 },
    extraWhen: { type: String, enum: ['half_full', 'day_full'], default: 'half_full' },
    rotation: {
      lastStartedTeamId: { type: mongoose.Schema.Types.ObjectId, ref: 'ArtistTeam', default: null },
      lastStartedAt: { type: Date, default: null },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedByName: { type: String, default: '' },
  },
  { timestamps: true },
);

export default mongoose.model('AllocationSettings', allocationSettingsSchema);
