const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const Product = require("../models/Product");
const Category = require("../models/Category");
const Brand = require("../models/Brands");
const { computeBundleMaxQty } = require("../utils/bundleStock");
const { cloudinary } = require("../config/cloudinary");
const mongoose = require("mongoose");

async function computeBundleTotals(bundleItems = []) {
  const ids = bundleItems.map((x) => x.product).filter(Boolean);
  const uniq = new Set(ids.map(String));
  if (uniq.size !== ids.length)
    throw new AppError("Duplicate product in bundle", 400);

  const children = await Product.find({ _id: { $in: ids } }).select(
    "_id price discountPrice isActive type",
  );

  const map = new Map(children.map((c) => [String(c._id), c]));

  let sumChildIndividual = 0;

  for (const it of bundleItems) {
    const child = map.get(String(it.product));
    const qty = Number(it.qty || 1);

    if (!Number.isFinite(qty) || qty < 1)
      throw new AppError("Invalid bundle qty", 400);
    if (!child) throw new AppError("Invalid bundle product(s)", 400);
    if (child.isActive === false)
      throw new AppError("Bundle contains inactive product", 400);
    if (child.type === "BUNDLE")
      throw new AppError("Bundle cannot include another bundle", 400);

    const p = Number(child.price || 0);
    const dp = child.discountPrice;

    // "individual price" used for comparison
    const hasValidDp =
      dp != null && dp !== "" && Number(dp) >= 0 && Number(dp) < p;

    if (!hasValidDp) {
      throw new AppError(
        "Bundle children must have a valid discountPrice",
        400,
      );
    }

    sumChildIndividual += Number(dp) * qty;
  }

  return { sumChildIndividual };
}

const toTags = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) {
    return Array.from(
      new Set(v.map((t) => String(t).trim().toLowerCase()).filter(Boolean)),
    );
  }
  // allow comma-separated string
  return Array.from(
    new Set(
      String(v)
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
};

async function computeBundleTags(bundleItems = []) {
  const ids = (bundleItems || []).map((x) => x.product).filter(Boolean);

  const children = await Product.find({ _id: { $in: ids } }).select("tags");

  const set = new Set();
  for (const c of children) {
    for (const t of c.tags || []) {
      const s = String(t).trim().toLowerCase();
      if (s) set.add(s);
    }
  }
  return Array.from(set);
}

function validateTimedOffer(price, discountPrice, timedOffer) {
  if (!timedOffer) return;
  if (timedOffer.isActive === false) return;

  if (timedOffer.isActive === true) {
    const offerPrice = Number(timedOffer.price);

    if (!Number.isFinite(offerPrice) || offerPrice <= 0) {
      throw new AppError("timedOffer.price is required", 400);
    }

    if (discountPrice == null) {
      throw new AppError("Timed offer requires discountPrice", 400);
    }

    // ✅ must be less than discountPrice
    if (!(offerPrice < Number(discountPrice))) {
      throw new AppError(
        "timedOffer.price must be less than discountPrice",
        400,
      );
    }

    // ✅ must also be less than MRP (price)
    if (price != null && !(offerPrice < Number(price))) {
      throw new AppError("timedOffer.price must be less than price", 400);
    }

    const startAt = new Date(timedOffer.startAt);
    const endAt = new Date(timedOffer.endAt);

    if (isNaN(startAt) || isNaN(endAt) || !(endAt > startAt)) {
      throw new AppError(
        "timedOffer.startAt and endAt must be valid and endAt > startAt",
        400,
      );
    }
  }
}

async function resolveBrandIds(brands) {
  if (!brands) return [];

  const parts = Array.from(
    new Set(
      String(brands)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  );

  if (!parts.length) return [];

  // already ObjectIds
  const objIds = parts
    .filter((x) => mongoose.Types.ObjectId.isValid(x))
    .map((x) => new mongoose.Types.ObjectId(x));

  // slugs
  const slugs = parts.filter((x) => !mongoose.Types.ObjectId.isValid(x));

  const slugDocs = slugs.length
    ? await Brand.find({ slug: { $in: slugs } }).select("_id")
    : [];

  return [...objIds, ...slugDocs.map((d) => d._id)];
}

async function resolveCategoryId(category) {
  if (!category) return null;

  // already ObjectId
  if (mongoose.Types.ObjectId.isValid(category)) {
    return new mongoose.Types.ObjectId(category);
  }

  // treat as slug
  const catDoc = await Category.findOne({
    slug: String(category).toLowerCase().trim(),
  }).select("_id");

  if (!catDoc) throw new AppError("Invalid category", 400);
  return catDoc._id;
}

async function getBundlesCategoryId() {
  const cat = await Category.findOne({ slug: "bundles" }).select("_id");
  if (!cat) throw new AppError("Create a category with slug 'bundles'", 400);
  return cat._id;
}

async function getMixedBrandId() {
  const b = await Brand.findOne({ slug: "mixed" }).select("_id");
  if (!b) throw new AppError("Create a brand with slug 'mixed'", 400);
  return b._id;
}

const escapeRegex = (s = "") => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toPoints = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v.map((s) => String(s).trim()).filter(Boolean);
  }
  return String(v)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
};

const MAX_SLUG_LEN = 60;

const sanitizeSlug = (s = "") => {
  const cleaned = s
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  const truncated = cleaned.length > MAX_SLUG_LEN;

  return {
    slug: cleaned.slice(0, MAX_SLUG_LEN).replace(/-+$/g, ""),
    truncated,
  };
};

async function makeUniqueSlug(baseSlug, excludeId = null) {
  let slug = baseSlug;
  let i = 1;

  while (
    await Product.exists({
      slug,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    })
  ) {
    const suffix = `-${i++}`;

    // ensure slug + suffix still fits max length
    slug =
      baseSlug.slice(0, MAX_SLUG_LEN - suffix.length).replace(/-+$/g, "") +
      suffix;
  }

  return slug;
}

exports.list = asyncHandler(async (req, res) => {
  const {
    ids = "", // ✅ ADD THIS
    search = "",
    category = "",
    brand = "",
    availability = "",
    sort = "",
    minPrice = "",
    maxPrice = "",
    page = "1",
    limit = "12",
    status = "",
    hasOffer = "",
    tags = "",
    tagMode = "any",
    type = "",
    lowStock = "",
    expiredOffer = "",
  } = req.query;

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 200);
  const skip = (pageNum - 1) * limitNum;
  const match = {};

  // ✅ IDS FILTER (comma-separated Mongo IDs)
  // Used by Wishlist to fetch "card-ready" products through the same pipeline
  if (ids) {
    const arr = String(ids)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((x) => mongoose.Types.ObjectId.isValid(x))
      .map((x) => new mongoose.Types.ObjectId(x));

    // strict UX: if user passed ids but none valid => return empty
    if (!arr.length) {
      return res.json({
        products: [],
        meta: {
          total: 0,
          page: pageNum,
          limit: limitNum,
          pages: 1,
          hasPrev: false,
          hasNext: false,
        },
      });
    }

    match._id = { $in: arr };
  }

  const isAdmin = req.user && req.user.role === "admin";

  if (!isAdmin) {
    // Public → only active
    match.isActive = true;
  } else {
    // Admin → optional status filter
    if (status === "active") {
      match.isActive = true;
    } else if (status === "inactive") {
      match.isActive = false;
    }
    // if status === "all" or empty → no filter
  }

  if (isAdmin) {
    // ✅ Filter by product type
    if (type === "bundle") {
      match.type = "BUNDLE";
    } else if (type === "single") {
      match.type = "SINGLE";
    }
  }

  // ✅ CATEGORY FILTER (supports single or multiple: id/slug, comma-separated)
  // ✅ CATEGORY FILTER (supports single or multiple: id/slug, comma-separated)
  if (category) {
    // allow: "gpu,ssd" OR "65ab...,gpu"
    const parts = Array.from(
      new Set(
        String(category)
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      ),
    );

    // separate ids vs slugs
    const ids = [];
    const slugs = [];

    for (const p of parts) {
      if (mongoose.Types.ObjectId.isValid(p))
        ids.push(new mongoose.Types.ObjectId(p));
      else slugs.push(p.toLowerCase());
    }

    // resolve slugs -> ids
    if (slugs.length) {
      const found = await Category.find({ slug: { $in: slugs } }).select(
        "_id slug",
      );

      // STRICT UX: if user provided slugs but any slug not found => show empty
      if (found.length !== slugs.length) {
        return res.json({
          products: [],
          meta: {
            total: 0,
            page: pageNum,
            limit: limitNum,
            pages: 1,
            hasPrev: false,
            hasNext: false,
          },
        });
      }

      ids.push(...found.map((c) => c._id));
    }

    // if nothing resolved, show nothing
    if (!ids.length) {
      return res.json({
        products: [],
        meta: {
          total: 0,
          page: pageNum,
          limit: limitNum,
          pages: 1,
          hasPrev: false,
          hasNext: false,
        },
      });
    }

    // single -> direct match, multiple -> $in
    match.category = ids.length === 1 ? ids[0] : { $in: ids };
  }

  // ✅ BRAND FILTER (supports single/multiple: id/slug, comma-separated)
  if (brand) {
    const brandIds = await resolveBrandIds(brand);

    // strict UX: if user provided something but nothing resolved => empty result
    if (!brandIds.length) {
      return res.json({
        products: [],
        meta: {
          total: 0,
          page: pageNum,
          limit: limitNum,
          pages: 1,
          hasPrev: false,
          hasNext: false,
        },
      });
    }

    match.brand = brandIds.length === 1 ? brandIds[0] : { $in: brandIds };
  }

  const availabilityMode = availability;

  const term = String(search || "").trim();
  const rx = term ? new RegExp(escapeRegex(term), "i") : null;

  const min = minPrice !== "" ? Number(minPrice) : null;
  const max = maxPrice !== "" ? Number(maxPrice) : null;

  const sortStage = (() => {
    // ✅ Default "Featured" (when sort is empty)
    if (!sort) return { featuredRank: 1, createdAt: -1, _id: -1 };

    if (sort === "price-asc") return { finalPrice: 1, _id: -1 };
    if (sort === "price-desc") return { finalPrice: -1, _id: -1 };
    if (sort === "discount-desc")
      return { discountPercent: -1, discountAmount: -1, _id: -1 };

    if (sort === "best-selling")
      return { soldCount: -1, createdAt: -1, _id: -1 };

    // newest
    return { createdAt: -1, _id: -1 };
  })();

  const tagArr = toTags(tags);

  if (tagArr.length) {
    match.tags = tagMode === "all" ? { $all: tagArr } : { $in: tagArr };
  }

  const basePipeline = [
    { $match: match },

    {
      $lookup: {
        from: "categories",
        localField: "category",
        foreignField: "_id",
        as: "categoryDoc",
      },
    },
    { $unwind: { path: "$categoryDoc", preserveNullAndEmptyArrays: true } },

    {
      $lookup: {
        from: "brands",
        localField: "brand",
        foreignField: "_id",
        as: "brandDoc",
      },
    },
    { $unwind: { path: "$brandDoc", preserveNullAndEmptyArrays: true } },
  ];

  if (rx) {
    basePipeline.push({
      $match: {
        $or: [
          { title: { $regex: rx } },
          { "brandDoc.name": { $regex: rx } },
          { description: { $regex: rx } },
          { "specs.keySpecs": { $regex: rx } },
          { "categoryDoc.name": { $regex: rx } },
          { tags: { $regex: rx } },
        ],
      },
    });
  }

  // Populate-like brand shape
  basePipeline.push({
    $addFields: {
      brand: {
        _id: "$brandDoc._id",
        name: "$brandDoc.name",
        slug: "$brandDoc.slug",
        logo: "$brandDoc.logo",
        ui: "$brandDoc.ui",
      },
    },
  });
  basePipeline.push({ $project: { brandDoc: 0 } });

  // Populate-like category shape
  basePipeline.push({
    $addFields: {
      category: {
        _id: "$categoryDoc._id",
        name: "$categoryDoc.name",
        slug: "$categoryDoc.slug",
      },
    },
  });
  basePipeline.push({ $project: { categoryDoc: 0 } });

  // ✅ Populate bundleItems.product via lookup (safe for non-bundles)
  basePipeline.push({
    $lookup: {
      from: "products",
      let: { ids: { $ifNull: ["$bundleItems.product", []] } },
      pipeline: [
        { $match: { $expr: { $in: ["$_id", "$$ids"] } } },
        {
          $project: {
            title: 1,
            slug: 1,
            price: 1,
            discountPrice: 1,
            images: 1,
            stock: 1,
            isActive: 1,
            tags: 1,
            avgRating: 1,
            ratingsCount: 1,
          },
        },
      ],
      as: "bundleProducts",
    },
  });

  // ✅ Replace bundleItems.product ObjectId with actual product object
  basePipeline.push({
    $addFields: {
      bundleItems: {
        $cond: [
          { $eq: ["$type", "BUNDLE"] },
          {
            $map: {
              input: { $ifNull: ["$bundleItems", []] },
              as: "bi",
              in: {
                qty: "$$bi.qty",
                product: {
                  $first: {
                    $filter: {
                      input: "$bundleProducts",
                      as: "bp",
                      cond: { $eq: ["$$bp._id", "$$bi.product"] },
                    },
                  },
                },
              },
            },
          },
          "$bundleItems",
        ],
      },
    },
  });

  basePipeline.push({ $project: { bundleProducts: 0 } });

  basePipeline.push({
    $match: {
      $or: [
        { type: { $ne: "BUNDLE" } },
        {
          $and: [
            { type: "BUNDLE" },
            {
              $expr: {
                $allElementsTrue: {
                  $map: {
                    input: { $ifNull: ["$bundleItems", []] },
                    as: "bi",
                    in: {
                      $and: [
                        { $ne: ["$$bi.product", null] },
                        { $eq: ["$$bi.product.isActive", true] },
                      ],
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    },
  });

  // ✅ Use stored price/discountPrice for BOTH SINGLE + BUNDLE
  basePipeline.push({
    $addFields: {
      price: { $toDouble: { $ifNull: ["$price", 0] } },
      discountPrice: {
        $cond: [
          {
            $and: [
              { $ne: ["$discountPrice", null] },
              { $lt: ["$discountPrice", "$price"] },
            ],
          },
          { $toDouble: "$discountPrice" },
          null,
        ],
      },
    },
  });

  const todayStartIST = getStartOfTodayIST(new Date());
  const tomorrowStartIST = new Date(
    todayStartIST.getTime() + 24 * 60 * 60 * 1000,
  );

  // ✅ Timed Offer + Final Price logic
  basePipeline.push({
    $addFields: {
      _now: "$$NOW",
      _hasTimedOffer: {
        $and: [
          { $eq: ["$timedOffer.isActive", true] },
          { $ne: ["$timedOffer.price", null] },
          { $ne: ["$timedOffer.startAt", null] },
          { $ne: ["$timedOffer.endAt", null] },
          { $lte: ["$timedOffer.startAt", "$$NOW"] },
          { $gt: ["$timedOffer.endAt", "$$NOW"] },
          { $ne: ["$discountPrice", null] },
          { $lt: [{ $toDouble: "$timedOffer.price" }, "$discountPrice"] },
        ],
      },

      _timedOfferEndedToday: {
        $and: [
          { $eq: ["$timedOffer.isActive", true] },
          { $ne: ["$timedOffer.endAt", null] },
          { $lte: ["$timedOffer.endAt", "$$NOW"] },
          { $gte: ["$timedOffer.endAt", todayStartIST] },
          { $lt: ["$timedOffer.endAt", tomorrowStartIST] },
        ],
      },
    },
  });

  // ✅ Featured rank (must be BEFORE $sort and BEFORE pagination)
  basePipeline.push({
    $addFields: {
      featuredRank: {
        $switch: {
          branches: [
            // 0: BUNDLE + LIVE offer
            {
              case: { $and: [{ $eq: ["$type", "BUNDLE"] }, "$_hasTimedOffer"] },
              then: 0,
            },
            // 1: LIVE offer (non-bundle)
            {
              case: { $and: [{ $ne: ["$type", "BUNDLE"] }, "$_hasTimedOffer"] },
              then: 1,
            },
            // 2: BUNDLE (no offer)
            {
              case: {
                $and: [
                  { $eq: ["$type", "BUNDLE"] },
                  { $not: ["$_hasTimedOffer"] },
                ],
              },
              then: 2,
            },
          ],
          default: 3, // 3: normal
        },
      },
    },
  });

  // ✅ allow both public + admin to filter "has active timed offer"
  if (hasOffer === "true") {
    basePipeline.push({ $match: { _hasTimedOffer: true } });
  }

  if (isAdmin && expiredOffer === "true") {
    basePipeline.push({
      $match: {
        $expr: {
          $and: [
            { $eq: ["$timedOffer.isActive", true] },
            { $ne: ["$timedOffer.endAt", null] },
            { $lte: ["$timedOffer.endAt", "$$NOW"] },
          ],
        },
      },
    });
  }

  // ✅ expose computed timed offer status to frontend
  basePipeline.push({
    $addFields: {
      "timedOffer.effectiveActive": "$_hasTimedOffer",
      "timedOffer.endedToday": "$_timedOfferEndedToday",
      "timedOffer.uiStatus": {
        $switch: {
          branches: [
            { case: "$_hasTimedOffer", then: "LIVE" },
            { case: "$_timedOfferEndedToday", then: "ENDED" },
          ],
          default: "NONE",
        },
      },
      "timedOffer.effectivePrice": {
        $cond: ["$_hasTimedOffer", { $toDouble: "$timedOffer.price" }, null],
      },
    },
  });

  basePipeline.push({
    $addFields: {
      finalPrice: {
        $cond: [
          "$_hasTimedOffer",
          { $toDouble: "$timedOffer.price" },
          {
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
          },
        ],
      },
    },
  });

  basePipeline.push({
    $addFields: {
      discountAmount: {
        $cond: [
          { $gt: ["$price", "$finalPrice"] },
          { $subtract: ["$price", "$finalPrice"] },
          0,
        ],
      },
    },
  });

  basePipeline.push({
    $addFields: {
      youSave: "$discountAmount",
      discountPercent: {
        $cond: [
          {
            $and: [{ $gt: ["$price", 0] }, { $gt: ["$discountAmount", 0] }],
          },
          {
            $round: [
              {
                $multiply: [{ $divide: ["$discountAmount", "$price"] }, 100],
              },
              0,
            ],
          },
          0,
        ],
      },
    },
  });

  if (
    (min !== null && !Number.isNaN(min)) ||
    (max !== null && !Number.isNaN(max))
  ) {
    const range = {};
    if (min !== null && !Number.isNaN(min)) range.$gte = min;
    if (max !== null && !Number.isNaN(max)) range.$lte = max;
    basePipeline.push({ $match: { finalPrice: range } });
  }

  basePipeline.push({ $sort: sortStage });

  // ✅ Compute bundleStock in aggregation
  basePipeline.push({
    $addFields: {
      bundleStock: {
        $cond: [
          { $eq: ["$type", "BUNDLE"] },
          {
            $ifNull: [
              {
                $min: {
                  $map: {
                    input: { $ifNull: ["$bundleItems", []] },
                    as: "bi",
                    in: {
                      $cond: [
                        {
                          $and: [
                            { $gt: ["$$bi.qty", 0] },
                            { $ne: ["$$bi.product", null] },
                          ],
                        },
                        {
                          $floor: {
                            $divide: [
                              { $ifNull: ["$$bi.product.stock", 0] },
                              "$$bi.qty",
                            ],
                          },
                        },
                        0,
                      ],
                    },
                  },
                },
              },
              0,
            ],
          },
          "$stock",
        ],
      },
    },
  });

  // ✅ Apply availability filter AFTER bundleStock exists
  // ✅ Apply availability filter AFTER bundleStock exists
  if (availabilityMode === "in") {
    basePipeline.push({ $match: { bundleStock: { $gt: 0 } } });
  }

  if (availabilityMode === "out" && !(isAdmin && lowStock === "true")) {
    basePipeline.push({ $match: { bundleStock: { $eq: 0 } } });
  }

  // ✅ Admin: low stock (1–5) – separate from out of stock
  if (isAdmin && lowStock === "true") {
    basePipeline.push({
      $match: { bundleStock: { $gte: 1, $lte: 5 } },
    });
  }

  basePipeline.push({
    $project: {
      _now: 0,
      _hasTimedOffer: 0,
      _timedOfferEndedToday: 0,
      featuredRank: 0,
    },
  });

  // ✅ FACET: data + total
  const pipeline = [
    ...basePipeline,
    {
      $facet: {
        data: [{ $skip: skip }, { $limit: limitNum }],
        meta: [{ $count: "total" }],
      },
    },
  ];

  const out = await Product.aggregate(pipeline);

  const products = out?.[0]?.data || [];
  const total = out?.[0]?.meta?.[0]?.total || 0;
  const pages = Math.max(Math.ceil(total / limitNum), 1);

  res.json({
    products,
    meta: {
      total,
      page: pageNum,
      limit: limitNum,
      pages,
      hasPrev: pageNum > 1,
      hasNext: pageNum < pages,
    },
  });
});

function getStartOfTodayIST(now = new Date()) {
  const IST_OFFSET_MIN = 330;
  const istMs = now.getTime() + IST_OFFSET_MIN * 60_000;
  const ist = new Date(istMs);

  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();

  const istMidnightUtcMs = Date.UTC(y, m, d) - IST_OFFSET_MIN * 60_000;
  return new Date(istMidnightUtcMs);
}

exports.listAdmin = asyncHandler(async (req, res) => {
  const todayStartIST = getStartOfTodayIST(new Date());

  await Product.updateMany(
    {
      "timedOffer.isActive": true,
      "timedOffer.endAt": { $ne: null, $lt: todayStartIST }, // ✅ only previous days
    },
    {
      $set: {
        "timedOffer.isActive": false,
        "timedOffer.price": null,
        "timedOffer.startAt": null,
        "timedOffer.endAt": null,
      },
    },
  );

  return exports.list(req, res);
});

const normalizeYouTubeUrl = (url) => {
  if (!url) return "";
  const raw = String(url).trim();
  if (!raw) return "";

  try {
    const u = new URL(raw);

    // allow youtu.be/<id>
    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.split("/").filter(Boolean)[0];
      return id ? `https://www.youtube.com/watch?v=${id}` : "";
    }

    // allow youtube.com/watch?v=<id>
    if (u.hostname.includes("youtube.com")) {
      const id = u.searchParams.get("v");

      // also allow /embed/<id>
      const parts = u.pathname.split("/").filter(Boolean);
      const embedIndex = parts.indexOf("embed");
      const embedId = embedIndex !== -1 ? parts[embedIndex + 1] : "";

      const finalId = id || embedId;
      return finalId ? `https://www.youtube.com/watch?v=${finalId}` : "";
    }

    return "";
  } catch {
    return "";
  }
};

exports.getBySlug = asyncHandler(async (req, res) => {
  const productDoc = await Product.findOne({ slug: req.params.slug })
    .populate("category", "name slug")
    .populate("brand", "name slug logo isActive ui")
    .populate({
      path: "bundleItems.product",
      select:
        "title slug price discountPrice images stock brand category description specs warranty youtubeUrl tags isActive avgRating ratingsCount",
    });

  if (!productDoc) throw new AppError("Product not found", 404);

  // ✅ FORCE nested populate for bundle children (brand + category)
  if (productDoc.type === "BUNDLE") {
    await Product.populate(productDoc, {
      path: "bundleItems.product.brand",
      select: "name slug logo isActive ui",
    });

    await Product.populate(productDoc, {
      path: "bundleItems.product.category",
      select: "name slug",
    });
  }

  const product = productDoc.toObject();

  // ✅ Bundle overall rating (weighted by ratingsCount)
  let bundleRating = null;

  if (product.type === "BUNDLE") {
    const items = Array.isArray(product.bundleItems) ? product.bundleItems : [];

    let totalWeighted = 0;
    let totalCount = 0;

    for (const bi of items) {
      const child = bi?.product;
      if (!child) continue;

      const avg = Number(child.avgRating || 0);
      const cnt = Number(child.ratingsCount || 0);

      totalWeighted += avg * cnt;
      totalCount += cnt;
    }

    const avgRating =
      totalCount > 0 ? Number((totalWeighted / totalCount).toFixed(2)) : 0;

    bundleRating = { avgRating, ratingsCount: totalCount };
  }

  // ✅ bundleStock (server-side)
  if (product.type === "BUNDLE") {
    product.bundleStock = computeBundleMaxQty(product);
  }

  // ✅ finalPrice + youSave + discountPercent
  const price2 = Number(product.price || 0);
  const dp2 = product.discountPrice;
  const hasDiscount2 = dp2 != null && Number(dp2) >= 0 && Number(dp2) < price2;

  const now = Date.now();
  const dp2n = dp2 != null ? Number(dp2) : null;

  const hasTimed =
    product.timedOffer?.isActive &&
    product.timedOffer?.price != null &&
    product.timedOffer?.startAt &&
    product.timedOffer?.endAt &&
    new Date(product.timedOffer.startAt).getTime() <= now &&
    new Date(product.timedOffer.endAt).getTime() > now &&
    dp2n != null &&
    Number(product.timedOffer.price) < dp2n;

  if (hasTimed) {
    product.finalPrice = Number(product.timedOffer.price);
  } else if (hasDiscount2) {
    product.finalPrice = Number(dp2);
  } else {
    product.finalPrice = price2;
  }

  product.youSave = Math.max(0, price2 - product.finalPrice);
  product.discountPercent =
    price2 > 0 ? Math.round((product.youSave / price2) * 100) : 0;

  // ✅ IMPORTANT: return the computed `product` (not productDoc.toObject())
  res.json({ product, bundleRating });
});

exports.create = asyncHandler(async (req, res) => {
  const {
    title,
    description,
    type,
    bundleItems,
    timedOffer,
    price,
    discountPrice,
    category,
    brand,
    warranty,
    specs,
    youtubeUrl,
    tags,
    images,
    stock,
    isActive,
  } = req.body;

  const isBundle = (type || "SINGLE") === "BUNDLE";

  // ✅ FORCE bundle category+brand (ignore frontend for bundles)
  let categoryId = await resolveCategoryId(category);
  let brandId = (await resolveBrandIds(brand))[0] || null;

  if (isBundle) {
    categoryId = await getBundlesCategoryId();
    brandId = await getMixedBrandId();
  }

  if (!title || (!isBundle && price === undefined) || !category) {
    throw new AppError("title, price (for single), category required", 400);
  }

  // ✅ define these early (so bundle validation can use them)
  const bundleMrp = Number(price);
  const bundleDiscount = Number(discountPrice);

  // ✅ Bundle validations
  if (isBundle) {
    if (!Array.isArray(bundleItems) || bundleItems.length < 2) {
      throw new AppError("Bundle must include at least 2 products", 400);
    }

    const { sumChildIndividual } = await computeBundleTotals(bundleItems);

    if (!Number.isFinite(bundleMrp) || bundleMrp <= 0) {
      throw new AppError("Bundle price (MRP) is required", 400);
    }
    if (!Number.isFinite(bundleDiscount) || bundleDiscount <= 0) {
      throw new AppError("Bundle discountPrice is required", 400);
    }

    if (!(bundleMrp < sumChildIndividual)) {
      throw new AppError(
        `Bundle price must be less than sum of child prices (${sumChildIndividual})`,
        400,
      );
    }

    if (!(bundleDiscount < bundleMrp)) {
      throw new AppError(
        "Bundle discountPrice must be less than bundle price",
        400,
      );
    }
  }

  // ✅ tags: SINGLE uses manual tags, BUNDLE inherits from children
  let finalTags = toTags(tags);
  if (isBundle) finalTags = await computeBundleTags(bundleItems);

  // ✅ prevent leaking fields into bundles
  const finalDescription = isBundle ? "" : description || "";
  const finalYoutubeUrl = isBundle ? "" : youtubeUrl || "";
  const finalSpecs = isBundle
    ? { keySpecs: [], compatibility: [], requirements: [] }
    : specs || {};
  const finalWarranty = isBundle ? { months: 0, text: "" } : warranty || {};

  validateTimedOffer(price, discountPrice, timedOffer);

  const { slug: baseSlug, truncated } = sanitizeSlug(req.body.slug || title);
  const slug = await makeUniqueSlug(baseSlug);

  const product = await Product.create({
    title,
    slug,
    description: finalDescription,

    price: isBundle ? bundleMrp : price,
    discountPrice: isBundle ? bundleDiscount : discountPrice,

    category: categoryId,
    brand: brandId,
    type: type || "SINGLE",
    bundleItems: isBundle ? bundleItems : [],

    timedOffer: timedOffer || {
      isActive: false,
      price: null,
      startAt: null,
      endAt: null,
    },

    warranty: {
      months: Number(finalWarranty?.months || 0),
      text: String(finalWarranty?.text || "").trim(),
    },

    specs: {
      keySpecs: toPoints(finalSpecs?.keySpecs),
      compatibility: toPoints(finalSpecs?.compatibility),
      requirements: toPoints(finalSpecs?.requirements),
    },

    youtubeUrl: normalizeYouTubeUrl(finalYoutubeUrl),

    tags: finalTags,
    images: Array.isArray(images) ? images : [],
    stock: stock ?? 0,
    isActive: isActive ?? true,
  });

  res.status(201).json({
    product,
    meta: { slugTruncated: truncated },
  });
});

exports.update = asyncHandler(async (req, res) => {
  const payload = { ...req.body };
  if ("category" in payload) {
    payload.category = await resolveCategoryId(payload.category);
  }

  if ("brand" in payload) {
    const b = payload.brand;

    if (!b) {
      payload.brand = null;
    } else if (mongoose.Types.ObjectId.isValid(b)) {
      payload.brand = new mongoose.Types.ObjectId(b);
    } else {
      const doc = await Brand.findOne({
        slug: String(b).toLowerCase().trim(),
      }).select("_id");

      if (!doc) throw new AppError("Invalid brand", 400);
      payload.brand = doc._id;
    }
  }

  // ✅ handle slug/title (custom slug allowed)
  if ("slug" in payload || "title" in payload) {
    const { slug: baseSlug } = sanitizeSlug(
      payload.slug || payload.title || "",
    );

    if (baseSlug) {
      payload.slug = await makeUniqueSlug(baseSlug, req.params.id); // exclude current product
    } else {
      delete payload.slug;
    }
  }

  // ✅ sanitize + merge specs if present
  if (payload.specs) {
    const existing = await Product.findById(req.params.id).select("specs");
    if (!existing) throw new AppError("Product not found", 404);

    payload.specs = {
      keySpecs:
        "keySpecs" in payload.specs
          ? toPoints(payload.specs.keySpecs)
          : toPoints(existing.specs?.keySpecs),

      compatibility:
        "compatibility" in payload.specs
          ? toPoints(payload.specs.compatibility)
          : toPoints(existing.specs?.compatibility),

      requirements:
        "requirements" in payload.specs
          ? toPoints(payload.specs.requirements)
          : toPoints(existing.specs?.requirements),
    };
  }

  if ("youtubeUrl" in payload) {
    payload.youtubeUrl = normalizeYouTubeUrl(payload.youtubeUrl);
  }

  // ✅ bundle validation + recompute totals (single DB hit)
  // ✅ bundle validation (DO NOT auto-overwrite price/discountPrice)
  if (
    "type" in payload ||
    "bundleItems" in payload ||
    "price" in payload ||
    "discountPrice" in payload
  ) {
    const existing = await Product.findById(req.params.id).select(
      "type bundleItems price discountPrice",
    );
    if (!existing) throw new AppError("Product not found", 404);

    const nextType = "type" in payload ? payload.type : existing.type;
    // ✅ If bundle, always lock category + brand
    if (nextType === "BUNDLE") {
      payload.category = await getBundlesCategoryId();
      payload.brand = await getMixedBrandId();
    }

    if (nextType === "BUNDLE") {
      const nextItems =
        "bundleItems" in payload ? payload.bundleItems : existing.bundleItems;

      if (!Array.isArray(nextItems) || nextItems.length < 2) {
        throw new AppError("Bundle must include at least 2 products", 400);
      }

      // ✅ bundles should NOT keep these fields from old SINGLE data
      payload.description = "";
      payload.youtubeUrl = "";
      payload.specs = { keySpecs: [], compatibility: [], requirements: [] };
      payload.warranty = { months: 0, text: "" };

      // ✅ Always recompute tags from children
      payload.tags = await computeBundleTags(nextItems);

      const { sumChildIndividual } = await computeBundleTotals(nextItems);

      const nextMrp = Number(
        "price" in payload ? payload.price : existing.price,
      );
      const nextDiscount = Number(
        "discountPrice" in payload
          ? payload.discountPrice
          : existing.discountPrice,
      );

      if (!Number.isFinite(nextMrp) || nextMrp <= 0) {
        throw new AppError("Bundle price (MRP) is required", 400);
      }
      if (!Number.isFinite(nextDiscount) || nextDiscount <= 0) {
        throw new AppError("Bundle discountPrice is required", 400);
      }

      // ✅ Rule A: bundle price < sum(child discountPrice (or fallback))
      if (!(nextMrp < sumChildIndividual)) {
        throw new AppError(
          `Bundle price must be less than sum of child prices (${sumChildIndividual})`,
          400,
        );
      }

      // ✅ Rule B: bundle discountPrice < bundle price
      if (!(nextDiscount < nextMrp)) {
        throw new AppError(
          "Bundle discountPrice must be less than bundle price",
          400,
        );
      }
    }

    if (nextType === "SINGLE") {
      payload.bundleItems = [];
    }
  }

  if ("timedOffer" in payload) {
    const existing = await Product.findById(req.params.id).select(
      "discountPrice",
    );

    const nextDiscount =
      "discountPrice" in payload
        ? payload.discountPrice
        : existing.discountPrice;

    validateTimedOffer(
      "price" in payload ? payload.price : existing.price,
      nextDiscount,
      payload.timedOffer,
    );
  }
  // ✅ SINGLE tags normalize (BUNDLE tags will still be overwritten below)
  if ("tags" in payload) {
    payload.tags = toTags(payload.tags);
  }

  const product = await Product.findByIdAndUpdate(req.params.id, payload, {
    new: true,
    runValidators: true,
  });

  if (product.type === "SINGLE" && "tags" in payload) {
    const bundleIds = await Product.distinct("_id", {
      type: "BUNDLE",
      "bundleItems.product": product._id,
    });

    // recompute tags for affected bundles
    for (const bid of bundleIds) {
      const b = await Product.findById(bid).select("bundleItems");
      if (!b) continue;

      const newTags = await computeBundleTags(b.bundleItems);
      await Product.findByIdAndUpdate(bid, { $set: { tags: newTags } });
    }
  }

  if (!product) throw new AppError("Product not found", 404);

  res.json({ product });
});

// controllers/product.controller.js
exports.bulk = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));

  const docs = await Product.find({ _id: { $in: validIds } })
    .select(
      "_id stock isActive price discountPrice title slug images type bundleItems",
    )
    .populate(
      "bundleItems.product",
      "title slug images stock price discountPrice tags",
    );

  const products = docs.map((d) => {
    const p = d.toObject();
    if (p.type === "BUNDLE") p.bundleStock = computeBundleMaxQty(p);
    return p;
  });

  res.json({ products });
});

exports.remove = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw new AppError("Product not found", 404);

  // ✅ delete cloudinary images first (if configured)
  if (process.env.CLOUDINARY_CLOUD_NAME && product.images?.length) {
    for (const img of product.images) {
      if (img?.public_id) {
        try {
          await cloudinary.uploader.destroy(img.public_id, {
            resource_type: "image",
          });
        } catch (err) {
          // don't crash if cloudinary delete fails
          console.log(
            "Cloudinary delete failed for:",
            img.public_id,
            err.message,
          );
        }
      }
    }
  }

  await product.deleteOne();

  res.json({ message: "Product deleted (images cleaned up)" });
});

exports.removeProductImage = asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const { public_id } = req.body;

  if (!public_id) throw new AppError("public_id is required", 400);

  const product = await Product.findById(productId);
  if (!product) throw new AppError("Product not found", 404);

  // ✅ OPTIONAL SAFETY: prevent deleting the last image
  if (product.images.length <= 1) {
    throw new AppError("Cannot delete the last image of a product", 400);
  }

  // Check image exists in product
  const exists = product.images?.some((img) => img.public_id === public_id);
  if (!exists) throw new AppError("Image not found in this product", 404);

  // ✅ Delete from Cloudinary (if configured)
  if (process.env.CLOUDINARY_CLOUD_NAME) {
    try {
      await cloudinary.uploader.destroy(public_id, { resource_type: "image" });
    } catch (err) {
      console.log("Cloudinary delete failed:", public_id, err.message);
    }
  }

  // ✅ Remove from DB array
  product.images = product.images.filter((img) => img.public_id !== public_id);
  await product.save();

  res.json({
    message: "Image removed from product",
    product,
  });
});

exports.listTags = asyncHandler(async (req, res) => {
  const q = String(req.query.search || "")
    .trim()
    .toLowerCase();
  const rx = q ? new RegExp(escapeRegex(q), "i") : null;

  const pipeline = [
    { $match: { isActive: true } }, // 👈 always only active
    { $unwind: "$tags" },
    ...(rx ? [{ $match: { tags: { $regex: rx } } }] : []),
    { $group: { _id: "$tags", count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: 200 },
    { $project: { _id: 0, tag: "$_id", count: 1 } },
  ];

  const tags = await Product.aggregate(pipeline);
  res.json({ tags });
});
