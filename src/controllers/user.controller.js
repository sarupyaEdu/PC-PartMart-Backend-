const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const User = require("../models/User");
const { cloudinary } = require("../config/cloudinary");


// GET /api/users/me
exports.getMe = asyncHandler(async (req, res) => {
  // req.user is already loaded in protect
  res.json({ success: true, user: req.user });
});

// PUT /api/users/me
// PUT /api/users/me
// PUT /api/users/me
// PUT /api/users/me
exports.updateMe = asyncHandler(async (req, res) => {
  // 🔒 never allow email updates
  delete req.body.email;
  delete req.body.role;

  const userId = req.user._id;

  // get existing user FIRST (to know old avatar)
  const existingUser = await User.findById(userId);
  if (!existingUser) throw new AppError("User not found", 404);

  const { name, phone, address, avatar } = req.body;

  const update = {};
  if (name !== undefined) update.name = name;
  if (phone !== undefined) update.phone = phone;
  if (address !== undefined) update.address = address;
  if (avatar !== undefined) update.avatar = avatar;

  const user = await User.findByIdAndUpdate(
    userId,
    { $set: update },
    { new: true, runValidators: true }
  ).select("-passwordHash");

  // 🧹 DELETE OLD AVATAR (after successful update)
  if (
    avatar?.public_id &&
    existingUser.avatar?.public_id &&
    avatar.public_id !== existingUser.avatar.public_id
  ) {
    try {
      await cloudinary.uploader.destroy(existingUser.avatar.public_id, {
        resource_type: "image",
      });
    } catch (err) {
      console.error("Failed to delete old avatar:", err.message);
      // ❗ do NOT throw — profile update already succeeded
    }
  }

  res.json({ success: true, user, message: "Profile updated" });
});

