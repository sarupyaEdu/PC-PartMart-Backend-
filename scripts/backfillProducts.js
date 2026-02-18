require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("../src/models/Product");

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    await Product.updateMany(
      { type: { $exists: false } },
      { $set: { type: "SINGLE" } }
    );

    await Product.updateMany(
      { bundleItems: { $exists: false } },
      { $set: { bundleItems: [] } }
    );

    await Product.updateMany(
      { tags: { $exists: false } },
      { $set: { tags: [] } }
    );

    await Product.updateMany(
      { images: { $exists: false } },
      { $set: { images: [] } }
    );

    console.log("Backfill complete ✅");
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
