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
