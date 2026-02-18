const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const { cloudinary } = require("../config/cloudinary");
const streamifier = require("streamifier");

const ensureCloudinary = () => {
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    throw new AppError("Cloudinary env not configured", 500);
  }
};

// Upload helper (buffer -> cloudinary)
const uploadBufferToCloudinary = ({ buffer, folder }) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image" },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    streamifier.createReadStream(buffer).pipe(stream);
  });
};

// ✅ Single image upload
exports.uploadImage = asyncHandler(async (req, res) => {
  ensureCloudinary();

  if (!req.file) {
    throw new AppError("No file uploaded (field name should be 'image')", 400);
  }

  const folder = req.body.folder || "pc-parts-shop/products";
  const result = await uploadBufferToCloudinary({ buffer: req.file.buffer, folder });

  res.status(201).json({
    url: result.secure_url,
    imageUrl: result.secure_url,
    public_id: result.public_id,
    width: result.width,
    height: result.height,
    format: result.format,
  });
});

// ✅ Multiple image upload: upload.array("images", 6)
exports.uploadImages = asyncHandler(async (req, res) => {
  ensureCloudinary();

  if (!req.files || req.files.length === 0) {
    throw new AppError("No files uploaded (field name should be 'images')", 400);
  }

  const folder = req.body.folder || "pc-parts-shop/products";

  // upload sequentially (simple + safe)
  const results = [];
  for (const f of req.files) {
    const r = await uploadBufferToCloudinary({ buffer: f.buffer, folder });
    results.push({
      url: r.secure_url,
      imageUrl: r.secure_url,
      public_id: r.public_id,
      width: r.width,
      height: r.height,
      format: r.format,
    });
  }

  res.status(201).json({
    count: results.length,
    images: results, // array of {imageUrl, public_id, ...}
  });
});

// ✅ Delete image by public_id
exports.deleteImage = asyncHandler(async (req, res) => {
  ensureCloudinary();

  const { public_id } = req.body;
  if (!public_id) throw new AppError("public_id is required", 400);

  // resource_type must match what you uploaded (image)
  const result = await cloudinary.uploader.destroy(public_id, { resource_type: "image" });

  // result: { result: 'ok' } or { result: 'not found' }
  if (result.result !== "ok" && result.result !== "not found") {
    throw new AppError("Failed to delete image", 500);
  }

  res.json({ message: "Delete request processed", cloudinary: result });
});
