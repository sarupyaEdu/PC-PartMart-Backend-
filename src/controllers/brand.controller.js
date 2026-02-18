const Brand = require("../models/Brands");
const AppError = require("../utils/AppError");
const asyncHandler = require("../utils/asyncHandler");
const { cloudinary } = require("../config/cloudinary");

const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

exports.createBrand = asyncHandler(async (req, res) => {
  const { name, logo, categories = [], isActive = true, ui } = req.body;

  if (!name) throw new AppError("Brand name is required", 400);
  if (!logo?.url) throw new AppError("Brand logo is required", 400);
  if (!Array.isArray(categories) || categories.length === 0)
    throw new AppError("Select at least 1 category", 400);

  const exists = await Brand.findOne({ name: name.trim() });
  if (exists) throw new AppError("Brand already exists", 409);

  const brand = await Brand.create({
    name: name.trim(),
    slug: slugify(name),
    logo,
    categories,
    isActive,
    ui: {
      scale: ui?.scale ?? 1,
      padding: ui?.padding ?? 8,
      bg: ui?.bg ?? "#ffffff",
      invert: ui?.invert ?? false,
    },
  });

  const populated = await Brand.findById(brand._id).populate(
    "categories",
    "name slug",
  );

  res.status(201).json({ brand: populated });
});

exports.getBrands = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 12)));
  const skip = (page - 1) * limit;

  const search = String(req.query.search || "").trim();
  const category = String(req.query.category || "").trim();
  const status = String(req.query.status || "").trim(); // active/inactive
  const sort = String(req.query.sort || "").trim();

  const filter = {};

  if (search) {
    filter.name = { $regex: search, $options: "i" };
  }

  if (category) {
    filter.categories = category; // matches array
  }

  if (status === "active") filter.isActive = true;
  if (status === "inactive") filter.isActive = false;

  let sortObj = { createdAt: -1 }; // default newest
  if (sort === "name-asc") sortObj = { name: 1 };
  if (sort === "name-desc") sortObj = { name: -1 };
  if (sort === "oldest") sortObj = { createdAt: 1 };
  if (sort === "newest") sortObj = { createdAt: -1 };

  const [total, brands] = await Promise.all([
    Brand.countDocuments(filter),
    Brand.find(filter)
      .populate("categories", "name slug")
      .sort(sortObj)
      .skip(skip)
      .limit(limit),
  ]);

  const pages = Math.max(1, Math.ceil(total / limit));

  res.json({
    brands,
    meta: {
      total,
      page,
      limit,
      pages,
      hasPrev: page > 1,
      hasNext: page < pages,
    },
  });
});

exports.updateBrand = asyncHandler(async (req, res) => {
  const { name, logo, categories, isActive, ui } = req.body;

  const brand = await Brand.findById(req.params.id);
  if (!brand) throw new AppError("Brand not found", 404);

  // ✅ keep old public_id BEFORE overwriting
  const oldPublicId = brand.logo?.public_id || null;

  if (name) {
    brand.name = name.trim();
    brand.slug = slugify(name);
  }

  if (Array.isArray(categories)) brand.categories = categories;
  if (typeof isActive === "boolean") brand.isActive = isActive;

  // ✅ save ui
  if (ui && typeof ui === "object") {
    brand.ui = {
      scale: ui.scale ?? brand.ui?.scale ?? 1,
      padding: ui.padding ?? brand.ui?.padding ?? 8,
      bg: ui.bg ?? brand.ui?.bg ?? "#ffffff",
      invert: ui.invert ?? brand.ui?.invert ?? false,
    };
  }

  // ✅ logo replace
  if (logo?.url) {
    brand.logo = logo;

    // ✅ delete old logo if different
    if (oldPublicId && logo.public_id && logo.public_id !== oldPublicId) {
      await cloudinary.uploader.destroy(oldPublicId, {
        resource_type: "image",
      });
    }
  }

  await brand.save();

  const populated = await Brand.findById(brand._id).populate(
    "categories",
    "name slug",
  );

  res.json({ brand: populated });
});


// ✅ DELETE brand
exports.deleteBrand = asyncHandler(async (req, res) => {
  const brand = await Brand.findById(req.params.id);
  if (!brand) throw new AppError("Brand not found", 404);

  // delete logo from cloudinary (optional)
  if (brand.logo?.public_id) {
    await cloudinary.uploader.destroy(brand.logo.public_id, {
      resource_type: "image",
    });
  }

  await brand.deleteOne();
  res.json({ message: "Brand deleted" });
});

// ✅ DELETE brand logo (Cloudinary + DB)
exports.deleteBrandLogo = asyncHandler(async (req, res) => {
  const brand = await Brand.findById(req.params.id);
  if (!brand) throw new AppError("Brand not found", 404);

  const pid = brand.logo?.public_id;

  // delete from cloudinary
  if (pid) {
    await cloudinary.uploader.destroy(pid, { resource_type: "image" });
  }

  // remove from DB
  brand.logo = null;
  await brand.save();

  res.json({ message: "Brand logo removed", brand });
});
