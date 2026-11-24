import mongoose from 'mongoose';

// An in-house ARTIST TEAM for the smart booking allocation (utils/artistAllocation.js): its main artist (the lead put on a work), her
// assistants, where she prefers to work, where she sits in the rotation, and her slots a day (2 morning + 1 evening by default).
// Set up on the CRM's Artist Management screen (routes/artistTeamRoutes.js). Kept apart from Employee: the team is the CRM's to arrange,
// while the employee record belongs to HR.
const artistTeamSchema = new mongoose.Schema(
  {
    name: { type: String, default: '', trim: true, maxlength: 80 },
    leadEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    assistantEmployeeIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }], default: [] },
    rotationOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    slots: {
      morning: { type: Number, default: 2, min: 0, max: 4 },
      evening: { type: Number, default: 1, min: 0, max: 4 },
    },
    extraAllowed: { type: Boolean, default: true }, // may take an EXTRA (4th) slot on a peak day
    preferredDistrictIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'District' }], default: [] },
    preferredPincodes: { type: [String], default: [] },
    notes: { type: String, default: '', trim: true, maxlength: 500 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedByName: { type: String, default: '' },
  },
  { timestamps: true },
);

// one active team per main artist
artistTeamSchema.index({ leadEmployeeId: 1 }, { unique: true, partialFilterExpression: { active: true } });
artistTeamSchema.index({ active: 1, rotationOrder: 1 });

export default mongoose.model('ArtistTeam', artistTeamSchema);
