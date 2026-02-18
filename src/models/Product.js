const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    description: { type: String, default: "" },

    price: { type: Number, required: true, min: 0 },
    discountPrice: { type: Number, min: 0 },

    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    brand: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Brand",
      default: null,
      required: true,
    },

    specs: {
      keySpecs: {
        type: [String],
        default: [],
      },
      compatibility: {
        type: [String],
        default: [],
      },
      requirements: {
        type: [String],
        default: [],
      },
    },

    warranty: {
      months: { type: Number, default: 0 },
      text: { type: String, default: "" },
    },

    youtubeUrl: {
      type: String,
      default: "",
      trim: true,
    },

    // e.g. { socket: "AM5", watt: "650W" }
    tags: {
      type: [String],
      default: [],
      set: (arr) =>
        Array.from(
          new Set(
            (Array.isArray(arr) ? arr : [])
              .map((t) => String(t).trim().toLowerCase())
              .filter(Boolean),
          ),
        ),
    },

    images: [
      {
        url: { type: String, required: true },
        public_id: { type: String, required: true },
      },
    ],

    stock: { type: Number, default: 0, min: 0 },
    soldCount: {
      type: Number,
      default: 0,
    },

    avgRating: { type: Number, default: 0 },
    ratingsCount: { type: Number, default: 0 },

    isActive: { type: Boolean, default: true },

    // ✅ Combo / Bundle support
    type: {
      type: String,
      enum: ["SINGLE", "BUNDLE"],
      default: "SINGLE",
      index: true,
    },

    bundleItems: {
      type: [
        {
          product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Product",
            required: true,
          },
          qty: { type: Number, default: 1, min: 1 },
        },
      ],
      default: [], // ✅ important
    },
    timedOffer: {
      isActive: { type: Boolean, default: false },
      price: { type: Number, min: 0, default: null },
      startAt: { type: Date, default: null },
      endAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

productSchema.pre("validate", function (next) {
  // discountPrice must not exceed price
  if (this.discountPrice != null && this.discountPrice > this.price) {
    return next(new Error("discountPrice cannot be greater than price"));
  }

  // timedOffer validation (dates stored as Date)
  if (this.timedOffer?.isActive) {
    const offerPrice = Number(this.timedOffer.price);
    if (!Number.isFinite(offerPrice) || offerPrice <= 0) {
      return next(new Error("timedOffer.price is required"));
    }

    if (this.discountPrice == null) {
      return next(new Error("Timed offer requires discountPrice"));
    }

    if (!(offerPrice < Number(this.discountPrice))) {
      return next(
        new Error("timedOffer.price must be less than discountPrice"),
      );
    }

    if (!(offerPrice < Number(this.price))) {
      return next(new Error("timedOffer.price must be less than price"));
    }

    const s = this.timedOffer.startAt
      ? new Date(this.timedOffer.startAt)
      : null;
    const e = this.timedOffer.endAt ? new Date(this.timedOffer.endAt) : null;

    if (!s || !e || isNaN(s) || isNaN(e) || !(e > s)) {
      return next(
        new Error("timedOffer.startAt/endAt must be valid and endAt > startAt"),
      );
    }
  }

  // bundle rules
  if (this.type === "BUNDLE") {
    if (!Array.isArray(this.bundleItems) || this.bundleItems.length < 2) {
      return next(new Error("Bundle must include at least 2 products"));
    }

    // bundle product should not rely on its own stock
    this.stock = 0;

    // Optional: ensure bundle itself has price + discountPrice (if you want required)
    if (!Number.isFinite(Number(this.price)) || Number(this.price) <= 0) {
      return next(new Error("Bundle price (MRP) is required"));
    }
    if (
      !Number.isFinite(Number(this.discountPrice)) ||
      Number(this.discountPrice) <= 0
    ) {
      return next(new Error("Bundle discountPrice is required"));
    }
    if (!(Number(this.discountPrice) < Number(this.price))) {
      return next(
        new Error("Bundle discountPrice must be less than bundle price"),
      );
    }
  } else {
    // for normal products, keep bundleItems empty
    this.bundleItems = [];
  }

  next();
});

// SEARCH
productSchema.index({ title: "text", description: "text", tags: "text" });

// FILTERS
productSchema.index({ category: 1 });
productSchema.index({ brand: 1 });
productSchema.index({ tags: 1 });
productSchema.index({ isActive: 1, stock: 1 });
productSchema.index({ isActive: 1, category: 1, stock: 1 });
productSchema.index({ isActive: 1, brand: 1, category: 1, stock: 1 });
productSchema.index({ "timedOffer.isActive": 1, "timedOffer.endAt": 1 });

// SORTING
productSchema.index({ isActive: 1, price: 1, discountPrice: 1 });
productSchema.index({ isActive: 1, createdAt: -1 });

module.exports = mongoose.model("Product", productSchema);
