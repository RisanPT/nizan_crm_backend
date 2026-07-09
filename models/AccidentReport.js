import mongoose from "mongoose";

const accidentReportSchema = new mongoose.Schema(
  {
    driver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    vehicle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vehicle",
    },
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
    },
    location: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
      address: { type: String },
    },
    photos: [
      {
        type: String,
        required: true,
      },
    ],
    description: {
      type: String,
      required: true,
    },
    // The other party involved in the accident (optional).
    opposite: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      vehicleNumber: { type: String, default: "" },
      notes: { type: String, default: "" },
    },
    status: {
      type: String,
      enum: ["reported", "investigating", "resolved"],
      default: "reported",
    },
  },
  { timestamps: true }
);

const AccidentReport = mongoose.model("AccidentReport", accidentReportSchema);

export default AccidentReport;
