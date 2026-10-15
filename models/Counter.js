import mongoose from 'mongoose';

// Named atomic sequences, e.g. { _id: 'invoice:26-27', seq: 12 }.
// Incremented with findOneAndUpdate($inc) so concurrent requests never share
// a number.
const counterSchema = mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false }
);

const Counter = mongoose.model('Counter', counterSchema);

export default Counter;
