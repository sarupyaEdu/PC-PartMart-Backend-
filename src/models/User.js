const mongoose = require("mongoose");

const addressSchema = new mongoose.Schema(
  {
    line1: { type: String, default: "" },
    line2: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    pincode: { type: String, default: "" },
    country: { type: String, default: "India" },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["customer", "admin"], default: "customer" },

    // ✅ new profile fields
    phone: { type: String, default: "" },
    avatar: {
      url: { type: String, default: "" },
      public_id: { type: String, default: "" },
    },
    address: { type: addressSchema, default: () => ({}) },
  },
  { timestamps: true },
);

module.exports = mongoose.model("User", userSchema);
