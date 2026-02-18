require("dotenv").config();

process.on("unhandledRejection", (err) => {
  console.error("❌ UNHANDLED REJECTION:", err);
});

process.on("uncaughtException", (err) => {
  console.error("❌ UNCAUGHT EXCEPTION:", err);
});

const app = require("./app");
const connectDB = require("./config/db.js");
const { initCloudinary } = require("./config/cloudinary");

const PORT = process.env.PORT || 4500;

(async () => {
  try {
    await connectDB(process.env.MONGO_URI);
    initCloudinary();

    app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
  } catch (err) {
    console.error("❌ Server startup failed:", err);
    process.exit(1);
  }
})();
