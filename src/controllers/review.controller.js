const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const Review = require("../models/Review");
const Order = require("../models/Order");
const Product = require("../models/Product");
const mongoose = require("mongoose");
const { cloudinary } = require("../config/cloudinary");


// ✅ recompute rating summary on Product
async function recomputeProductRating(productId) {
  const pid = new mongoose.Types.ObjectId(productId);

  const stats = await Review.aggregate([
    { $match: { product: pid } },
    {
      $group: {
        _id: "$product",
        avgRating: { $avg: "$rating" },
        ratingsCount: { $sum: 1 },
      },
    },
  ]);

  const update =
    stats.length > 0
      ? {
          avgRating: Number(stats[0].avgRating.toFixed(2)),
          ratingsCount: stats[0].ratingsCount,
        }
      : { avgRating: 0, ratingsCount: 0 };

  await Product.findByIdAndUpdate(productId, update);
}

// ✅ DELIVERED-only purchase check (single OR inside bundle)
async function findDeliveredOrderForProduct(userId, productId) {
  const uid = new mongoose.Types.ObjectId(userId);
  const pid = new mongoose.Types.ObjectId(productId);

  // ✅ 1) direct: product bought as an order line and delivered
  const direct = await Order.findOne({
    userId: uid,
    status: "DELIVERED",
    "items.productId": pid,
  }).select("_id");

  if (direct) return direct;

  // ✅ 2) bundle-child: delivered order contains a bundle whose bundleItems contains pid
  // Find delivered orders (only ids + productIds)
  const deliveredOrders = await Order.find({
    userId: uid,
    status: "DELIVERED",
  }).select("_id items.productId");

  if (!deliveredOrders.length) return null;

  // collect ordered productIds
  const orderedIds = Array.from(
    new Set(
      deliveredOrders
        .flatMap((o) => (o.items || []).map((it) => it.productId))
        .filter(Boolean)
        .map(String),
    ),
  );

  if (!orderedIds.length) return null;

  // among ordered ids, check if any is a bundle that contains pid as child
  const bundleExists = await Product.exists({
    _id: { $in: orderedIds },
    type: "BUNDLE",
    "bundleItems.product": pid,
  });

  if (!bundleExists) return null;

  // returning any delivered order id is enough as proof
  return deliveredOrders[0];
}

// GET /api/reviews/can-review/:productId
exports.canReviewProduct = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { productId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(productId))
    throw new AppError("Invalid productId", 400);

  const existing = await Review.findOne({ user: userId, product: productId })
    .select("_id")
    .lean();

  if (existing)
    return res.json({ canReview: false, reason: "ALREADY_REVIEWED" });

  const order = await findDeliveredOrderForProduct(userId, productId);
  if (!order)
    return res.json({
      canReview: false,
      reason: "NOT_DELIVERED_OR_NOT_PURCHASED",
    });

  res.json({ canReview: true, orderId: order._id });
});

// POST /api/reviews  (multipart: images[])
exports.createReview = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { productId, rating, title, comment } = req.body;
  const r = Number(rating);
  if (!Number.isFinite(r) || r < 1 || r > 5) {
    throw new AppError("rating must be between 1 and 5", 400);
  }

  if (!mongoose.Types.ObjectId.isValid(productId))
    throw new AppError("Invalid productId", 400);

  const product = await Product.findById(productId).select("_id type isActive");
  if (!product) throw new AppError("Product not found", 404);
  if (product.isActive === false)
    throw new AppError("Product is not active", 400);

  // ✅ You said: bundle review should come from child product only
  if ((product.type || "SINGLE") === "BUNDLE") {
    throw new AppError(
      "Bundle product cannot be reviewed directly. Review individual products from the bundle.",
      400,
    );
  }

  // ✅ delivered-only
  const order = await findDeliveredOrderForProduct(userId, productId);
  if (!order) throw new AppError("You can review only after delivery.", 403);

  // ✅ upload review images (optional)
  let uploadedImages = [];
  if (req.files && req.files.length > 0) {
    for (const file of req.files) {
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: "pc-parts-shop/reviews" },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          },
        );
        stream.end(file.buffer);
      });

      uploadedImages.push({
        url: result.secure_url,
        public_id: result.public_id,
      });
    }
  }

  let review;
  try {
    review = await Review.create({
      user: userId,
      product: productId,
      rating: r,
      title,
      comment,
      images: uploadedImages,
      order: order._id,
    });
  } catch (err) {
    if (err?.code === 11000)
      throw new AppError("You already reviewed this product.", 409);
    throw err;
  }

  await recomputeProductRating(productId);

  res.status(201).json({ review });
});

// GET /api/reviews/product/:productId
exports.listProductReviews = asyncHandler(async (req, res) => {
  const { productId } = req.params;

  const reviews = await Review.find({ product: productId })
    .populate("user", "name avatar")
    .sort({ createdAt: -1 })
    .lean();

  res.json({ reviews });
});

// DELETE /api/reviews/my/:productId
// DELETE /api/reviews/me/:productId
exports.deleteMyReviewForProduct = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { productId } = req.params;

  const review = await Review.findOneAndDelete({
    user: userId,
    product: productId,
  });

  if (!review) throw new AppError("Review not found", 404);

  if (review.images?.length) {
    for (const img of review.images) {
      if (img?.public_id) await cloudinary.uploader.destroy(img.public_id);
    }
  }

  await recomputeProductRating(productId);

  res.json({ ok: true });
});

// PUT /api/reviews/me/:productId  (multipart: images[])
// body can include: rating, title, comment, removeImagePublicIds
exports.updateMyReviewForProduct = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { productId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(productId))
    throw new AppError("Invalid productId", 400);

  const review = await Review.findOne({ user: userId, product: productId });
  if (!review) throw new AppError("Review not found", 404);

  // --- fields ---
  const { rating, title, comment } = req.body;

  if (rating != null && rating !== "") {
    const r = Number(rating);
    if (!Number.isFinite(r) || r < 1 || r > 5)
      throw new AppError("rating must be between 1 and 5", 400);
    review.rating = r;
  }

  if (title != null) review.title = String(title);
  if (comment != null) review.comment = String(comment);

  // --- remove selected images ---
  // Accept formats:
  // 1) JSON string: '["pid1","pid2"]'
  // 2) comma string: "pid1,pid2"
  // 3) repeated fields: removeImagePublicIds=pid1&removeImagePublicIds=pid2
  let removeIds = req.body.removeImagePublicIds;

  if (typeof removeIds === "string") {
    const s = removeIds.trim();

    if (s.startsWith("[")) {
      try {
        removeIds = JSON.parse(s);
      } catch {
        removeIds = [];
      }
    } else {
      removeIds = s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    }
  }

  if (!Array.isArray(removeIds)) removeIds = [];

  if (removeIds.length && Array.isArray(review.images)) {
    // delete from cloudinary
    for (const pid of removeIds) {
      if (pid) await cloudinary.uploader.destroy(pid);
    }
    // remove from db array
    review.images = review.images.filter(
      (img) => !removeIds.includes(img.public_id),
    );
  }

  // --- add new images ---
  const currentCount = Array.isArray(review.images) ? review.images.length : 0;
  const newFiles = Array.isArray(req.files) ? req.files : [];
  const remainingSlots = Math.max(0, 5 - currentCount);

  if (newFiles.length > remainingSlots) {
    throw new AppError(
      `You can upload max ${remainingSlots} more image(s).`,
      400,
    );
  }

  if (newFiles.length) {
    const uploaded = [];

    for (const file of newFiles) {
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: "reviews" },
          (error, result) => (error ? reject(error) : resolve(result)),
        );
        stream.end(file.buffer);
      });

      uploaded.push({ url: result.secure_url, public_id: result.public_id });
    }

    review.images = [...(review.images || []), ...uploaded];
  }

  await review.save();
  await recomputeProductRating(productId);

  const populated = await Review.findById(review._id)
    .populate("user", "name avatar")
    .lean();

  res.json({ review: populated });
});

// GET /api/reviews/bundle/:bundleId
exports.listBundleReviews = asyncHandler(async (req, res) => {
  const { bundleId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(bundleId))
    throw new AppError("Invalid bundleId", 400);

  const bundle = await Product.findById(bundleId)
    .select("type bundleItems")
    .populate(
      "bundleItems.product",
      "title slug images avgRating ratingsCount",
    );

  if (!bundle) throw new AppError("Bundle not found", 404);

  if ((bundle.type || "SINGLE") !== "BUNDLE") {
    throw new AppError("Product is not a bundle", 400);
  }

  const children = [];

  for (const bi of bundle.bundleItems || []) {
    const child = bi.product;
    if (!child) continue;

    const reviews = await Review.find({ product: child._id })
      .populate("user", "name avatar")
      .sort({ createdAt: -1 })
      .lean();

    children.push({
      product: child,
      reviews,
    });
  }

  res.json({ children });
});

exports.getMyReviewForProduct = asyncHandler(async (req, res) => {
  const { productId } = req.params;

  const review = await Review.findOne({
    product: productId,
    user: req.user._id,
  }).populate("user", "name avatar");

  if (!review) return res.status(404).json({ message: "No review found" });

  res.json({ review });
});
