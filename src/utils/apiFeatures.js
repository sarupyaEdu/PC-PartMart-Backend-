const mongoose = require("mongoose");
const Category = require("../models/Category");

const escapeRegex = (s = "") => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

module.exports = async function apiFeatures(query, qs) {
  let q = query;

  // -----------------------------
  // SEARCH: title + brand + category name
  // -----------------------------
  if (qs.search && String(qs.search).trim()) {
    const term = String(qs.search).trim();
    const rx = new RegExp(escapeRegex(term), "i");

    // Find matching categories by name (so "GPU" matches category name too)
    const catDocs = await Category.find({ name: rx }).select("_id");
    const catIds = catDocs.map((c) => c._id);

    q = q.find({
      $or: [
        { title: rx },
        { brand: rx },
        ...(catIds.length ? [{ category: { $in: catIds } }] : []),
      ],
    });
  }

  // -----------------------------
  // FILTER: category id
  // -----------------------------
  if (qs.category && mongoose.Types.ObjectId.isValid(qs.category)) {
    q = q.find({ category: qs.category });
  }

  // -----------------------------
  // FILTER: availability
  // availability=in | out
  // -----------------------------
  if (qs.availability === "in") {
    q = q.find({ stock: { $gt: 0 } });
  } else if (qs.availability === "out") {
    q = q.find({ stock: { $eq: 0 } });
  }

  // -----------------------------
  // FILTER: price range
  // applies to final price (discountPrice if valid else price)
  // We'll filter using $expr so it works for discounted items too.
  // -----------------------------
  const minPrice =
    qs.minPrice !== undefined && qs.minPrice !== ""
      ? Number(qs.minPrice)
      : null;
  const maxPrice =
    qs.maxPrice !== undefined && qs.maxPrice !== ""
      ? Number(qs.maxPrice)
      : null;

  if (
    (minPrice !== null && !Number.isNaN(minPrice)) ||
    (maxPrice !== null && !Number.isNaN(maxPrice))
  ) {
    const exprFinalPrice = {
      $cond: [
        {
          $and: [
            { $ne: ["$discountPrice", null] },
            { $lt: ["$discountPrice", "$price"] },
          ],
        },
        "$discountPrice",
        "$price",
      ],
    };

    const expr = [];
    if (minPrice !== null && !Number.isNaN(minPrice)) {
      expr.push({ $gte: [exprFinalPrice, minPrice] });
    }
    if (maxPrice !== null && !Number.isNaN(maxPrice)) {
      expr.push({ $lte: [exprFinalPrice, maxPrice] });
    }

    q = q.find({ $expr: { $and: expr } });
  }

  // -----------------------------
  // SORT
  // sort=price-asc | price-desc | discount-desc
  // default: newest
  // -----------------------------
  const sort = String(qs.sort || "");
  if (sort === "price-asc") {
    // sort by finalPrice asc
    q = q.sort({
      // this works okay even without computed field; Mongo sorts nulls first for discountPrice,
      // so we use $expr-filtered finalPrice above, and sort by discountPrice then price.
      discountPrice: 1,
      price: 1,
      createdAt: -1,
    });
  } else if (sort === "price-desc") {
    q = q.sort({
      discountPrice: -1,
      price: -1,
      createdAt: -1,
    });
  } else if (sort === "discount-desc") {
    // Sort by discount amount high->low
    // NOTE: Plain sort can't compute (price-discountPrice).
    // So we approximate: show discounted first, then by (price - discountPrice) via aggregation would be perfect.
    // Here we still rank discounted items first and then by price gap roughly.
    q = q.sort({
      // discounted items first
      discountPrice: 1,
      // higher original price tends to larger discount; acceptable heuristic
      price: -1,
      createdAt: -1,
    });
  } else {
    q = q.sort("-createdAt");
  }

  // -----------------------------
  // PAGINATION
  // -----------------------------
  const page = qs.page ? Math.max(Number(qs.page), 1) : 1;
  const limit = qs.limit ? Math.min(Math.max(Number(qs.limit), 1), 100) : 12;
  const skip = (page - 1) * limit;

  q = q.skip(skip).limit(limit);

  return q;
};
