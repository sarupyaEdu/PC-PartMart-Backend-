const Wishlist = require("../models/Wishlist");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");

const getOrCreateWishlist = async (userId) => {
  let wl = await Wishlist.findOne({ user: userId });
  if (!wl) wl = await Wishlist.create({ user: userId, items: [] });
  return wl;
};

// GET /api/wishlist
exports.getMyWishlist = asyncHandler(async (req, res) => {
  const wl = await getOrCreateWishlist(req.user._id);

  await wl.populate([
    {
      path: "items.product",
      select:
        "title name productName slug price discountPrice images stock brand category rating avgRating",
      populate: [
        { path: "brand", select: "name" },
        { path: "category", select: "name" },
      ],
    },
  ]);

  res.status(200).json({
    status: "success",
    results: wl.items.length,
    data: wl,
  });
});

// POST /api/wishlist/toggle/:productId
exports.toggleWishlistItem = asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const wl = await getOrCreateWishlist(req.user._id);

  const idx = wl.items.findIndex(
    (x) => String(x.product) === String(productId),
  );

  let action = "added";
  if (idx >= 0) {
    wl.items.splice(idx, 1);
    action = "removed";
  } else {
    wl.items.unshift({ product: productId });
  }

  await wl.save();

  res.status(200).json({
    status: "success",
    action,
    count: wl.items.length,
  });
});

// POST /api/wishlist/add/:productId (optional)
exports.addToWishlist = asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const wl = await getOrCreateWishlist(req.user._id);

  const exists = wl.items.some((x) => String(x.product) === String(productId));

  if (!exists) wl.items.unshift({ product: productId });
  await wl.save();

  res.status(200).json({
    status: "success",
    message: exists ? "Already in wishlist" : "Added to wishlist",
    count: wl.items.length,
  });
});

// DELETE /api/wishlist/remove/:productId
exports.removeFromWishlist = asyncHandler(async (req, res, next) => {
  const { productId } = req.params;
  const wl = await getOrCreateWishlist(req.user._id);

  const before = wl.items.length;
  wl.items = wl.items.filter((x) => String(x.product) !== String(productId));

  if (wl.items.length === before) {
    return next(new AppError("Item not found in wishlist", 404));
  }

  await wl.save();

  res.status(200).json({
    status: "success",
    message: "Removed from wishlist",
    count: wl.items.length,
  });
});

// DELETE /api/wishlist/clear
exports.clearWishlist = asyncHandler(async (req, res) => {
  const wl = await getOrCreateWishlist(req.user._id);
  wl.items = [];
  await wl.save();

  res.status(200).json({
    status: "success",
    message: "Wishlist cleared",
    count: 0,
  });
});

exports.getWishlistIds = asyncHandler(async (req, res) => {
  const wl = await Wishlist.findOne({ user: req.user._id }).select(
    "items.product",
  );

  const ids = (wl?.items || []).map((x) => String(x.product));

  res.status(200).json({
    status: "success",
    data: ids,
  });
});
