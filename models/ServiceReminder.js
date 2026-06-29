import mongoose from "mongoose";

const serviceReminderSchema = new mongoose.Schema(
  {
    vehicle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
      required: true,
    },
    serviceType: {
      type: String,
      enum: ["Pollution", "Insurance", "Tax", "Maintenance", "Oil Change", "Other"],
      required: true,
    },
    dueDate: {
      type: Date,
      // Date can be optional if it's purely KM based
    },
    dueKm: {
      type: Number,
      // KM can be optional if it's purely Date based
    },
    status: {
      type: String,
      enum: ["pending", "completed"],
      default: "pending",
    },
    notes: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// Ensure at least one of dueDate or dueKm is provided
serviceReminderSchema.pre('save', function(next) {
  if (!this.dueDate && !this.dueKm) {
    next(new Error("Either dueDate or dueKm must be provided for a service reminder."));
  } else {
    next();
  }
});

const ServiceReminder = mongoose.model("ServiceReminder", serviceReminderSchema);
export default ServiceReminder;
