const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const {
  notFound,
  globalErrorHandler,
} = require("./middleware/error.middleware");

const authRoutes = require("./routes/auth.routes");
const categoryRoutes = require("./routes/category.routes");
const productRoutes = require("./routes/product.routes");
const orderRoutes = require("./routes/order.routes");
const supportRoutes = require("./routes/support.routes");
const uploadRoutes = require("./routes/upload.routes");

const app = express();

app.use(helmet());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

const allowedOrigins = [process.env.CLIENT_URL, process.env.ADMIN_URL].filter(
  Boolean
); // removes undefined values

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow requests without origin (Postman, curl, server-to-server)
      if (!origin) return cb(null, true);

      if (allowedOrigins.includes(origin)) {
        return cb(null, true);
      }

      return cb(new Error("Not allowed by CORS"), false);
    },
    credentials: true,
  })
);

app.get("/", (req, res) => res.json({ ok: true, message: "API running" }));

app.use("/api/auth", authRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/uploads", uploadRoutes);

app.use(notFound);
app.use(globalErrorHandler);

module.exports = app;
