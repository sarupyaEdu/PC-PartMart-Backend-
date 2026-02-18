const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, default: "", trim: true, maxlength: 120 },
    comment: { type: String, default: "", trim: true, maxlength: 2000 },

    // ✅ review images (Cloudinary)
    images: [{ url: String, public_id: String }],

    // optional: store delivered order that proved purchase
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
  },
  { timestamps: true }
);

// ✅ One review per user per product (LIFETIME)
reviewSchema.index({ user: 1, product: 1 }, { unique: true });


module.exports = mongoose.model("Review", reviewSchema);
