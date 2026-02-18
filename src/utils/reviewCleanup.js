const Review = require("../models/Review");
const Product = require("../models/Product");
const mongoose = require("mongoose");
const { cloudinary } = require("../config/cloudinary");

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

async function deleteUserReviewsForProducts(userId, productIds = []) {
  const uniq = [...new Set(productIds.map(String))];

  const reviews = await Review.find({
    user: userId,
    product: { $in: uniq },
  }).select("_id product images");

  // delete images
  for (const r of reviews) {
    if (r.images?.length) {
      for (const img of r.images) {
        if (img?.public_id) await cloudinary.uploader.destroy(img.public_id);
      }
    }
  }

  await Review.deleteMany({
    user: userId,
    product: { $in: uniq },
  });

  // recompute ratings for affected products
  await Promise.all(uniq.map((pid) => recomputeProductRating(pid)));
}

module.exports = { deleteUserReviewsForProducts };
