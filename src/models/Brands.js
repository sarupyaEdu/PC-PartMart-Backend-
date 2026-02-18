const mongoose = require("mongoose");

const brandSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    slug: { type: String, trim: true, unique: true },

    logo: {
      url: { type: String, default: "" },
      public_id: { type: String, default: "" },
    },
    ui: {
      scale: { type: Number, default: 1 }, // 0.8 – 1.3 recommended
      padding: { type: Number, default: 8 }, // px
      bg: { type: String, default: "#ffffff" }, // background color
      invert: { type: Boolean, default: false }, // for dark logos
    },

    categories: [{ type: mongoose.Schema.Types.ObjectId, ref: "Category" }],

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Brand", brandSchema);
