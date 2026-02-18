const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const Category = require("../models/Category");

const slugify = (s) =>
  s
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]+/g, "");

exports.getAll = asyncHandler(async (req, res) => {
  const categories = await Category.find().sort("name");
  res.json({ categories });
});

exports.getBySlug = asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || "")
    .toLowerCase()
    .trim();
  const category = await Category.findOne({ slug });
  if (!category) throw new AppError("Category not found", 404);
  res.json({ category });
});

exports.create = asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  if (!name) throw new AppError("Category name required", 400);

  const slug = slugify(name);
  const cat = await Category.create({
    name,
    slug,
    description: description || "",
  });
  res.status(201).json({ category: cat });
});

exports.update = asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  const update = {};
  if (name) {
    update.name = name;
    update.slug = slugify(name);
  }
  if (description !== undefined) update.description = description;

  const cat = await Category.findByIdAndUpdate(req.params.id, update, {
    new: true,
  });
  if (!cat) throw new AppError("Category not found", 404);

  res.json({ category: cat });
});

exports.remove = asyncHandler(async (req, res) => {
  const cat = await Category.findByIdAndDelete(req.params.id);
  if (!cat) throw new AppError("Category not found", 404);
  res.json({ message: "Category deleted" });
});
