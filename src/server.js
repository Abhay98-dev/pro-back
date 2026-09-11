import express from "express";
import cors from "cors";

import { config } from "./config.js";
import { runPipeline } from "./services/pipeline.js";

const app = express();

/*
 * ---------------------------------------------------------
 * CORS
 * ---------------------------------------------------------
 *
 * Local development:
 *   http://localhost:5173  -> Vite
 *   http://localhost:3000  -> React/Next
 *
 * Production:
 *   Add your Vercel frontend URL to ALLOWED_ORIGINS
 *
 * Example:
 *   ALLOWED_ORIGINS=https://your-app.vercel.app,http://localhost:5173
 */

const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ||
  "http://localhost:5173,http://localhost:3000"
)
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no Origin header
      // (curl, Postman, server-to-server requests, etc.)
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error(`CORS blocked origin: ${origin}`)
      );
    },

    methods: ["GET", "POST", "OPTIONS"],

    allowedHeaders: [
      "Content-Type",
      "Authorization"
    ]
  })
);


/*
 * ---------------------------------------------------------
 * BODY PARSER
 * ---------------------------------------------------------
 */

app.use(
  express.json({
    limit: "2mb"
  })
);


/*
 * ---------------------------------------------------------
 * HEALTH CHECK
 * ---------------------------------------------------------
 *
 * Used by:
 *   - Render health checks
 *   - Browser testing
 *   - Deployment verification
 */

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "sih26143-node",
    timestamp: new Date().toISOString()
  });
});


/*
 * ---------------------------------------------------------
 * PIPELINE
 * ---------------------------------------------------------
 *
 * Frontend:
 *
 * POST /api/run-pipeline
 *
 * Request:
 *
 * {
 *   "region": {
 *     "min_lon": 72.5,
 *     "min_lat": 18.0,
 *     "max_lon": 73.5,
 *     "max_lat": 19.0
 *   },
 *   "date": "2024-03-15"
 * }
 *
 * Node then:
 *
 *   1. Calls Python /detect
 *   2. Calls Python /hindcast
 *   3. Loads AIS
 *   4. Finds dark vessels
 *   5. Calculates reachable zones
 *   6. Calculates attribution scores
 *   7. Ranks suspects
 */

app.post("/api/run-pipeline", async (req, res) => {
  try {
    console.log(
      "[PIPELINE] Starting pipeline..."
    );

    console.log(
      "[PIPELINE] Request:",
      JSON.stringify(req.body)
    );

    const result = await runPipeline(req.body);

    console.log(
      "[PIPELINE] Pipeline completed successfully"
    );

    return res.status(200).json(result);

  } catch (error) {

    console.error(
      "[PIPELINE] Pipeline failed:"
    );

    console.error(error);

    /*
     * pipeline.js may attach:
     *
     * error.httpStatus
     * error.failedStage
     *
     * according to the Node/Python contract.
     */

    const statusCode =
      Number.isInteger(error.httpStatus)
        ? error.httpStatus
        : 500;

    const failedStage =
      error.failedStage ||
      "attribution";

    return res
      .status(statusCode)
      .json({
        status: "error",

        message:
          error.message ||
          "Pipeline failed",

        failed_stage: failedStage
      });
  }
});


/*
 * ---------------------------------------------------------
 * 404 HANDLER
 * ---------------------------------------------------------
 */

app.use((req, res) => {
  res.status(404).json({
    status: "error",
    message: `Route not found: ${req.method} ${req.originalUrl}`
  });
});


/*
 * ---------------------------------------------------------
 * GLOBAL ERROR HANDLER
 * ---------------------------------------------------------
 */

app.use((error, req, res, next) => {

  console.error(
    "[SERVER] Unhandled error:"
  );

  console.error(error);

  /*
   * CORS errors
   */
  if (
    error.message &&
    error.message.startsWith("CORS blocked origin:")
  ) {
    return res.status(403).json({
      status: "error",
      message: error.message
    });
  }

  return res.status(500).json({
    status: "error",
    message: "Internal server error"
  });
});


/*
 * ---------------------------------------------------------
 * START SERVER
 * ---------------------------------------------------------
 *
 * Render provides process.env.PORT.
 *
 * Locally your config.js should fall back to 5000.
 */

const port =
  process.env.PORT ||
  config.port ||
  5000;

app.listen(port, "0.0.0.0", () => {

  console.log(
    "========================================"
  );

  console.log(
    "SIH26143 Node.js Backend"
  );

  console.log(
    `Server running on port ${port}`
  );

  console.log(
    `Python service: ${config.pythonServiceUrl}`
  );

  console.log(
    "========================================"
  );
});