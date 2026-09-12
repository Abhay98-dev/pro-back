import express from "express";
import cors from "cors";

import { config } from "./config.js";
import { runPipeline } from "./services/pipeline.js";

const app = express();

/*
 * =========================================================
 * CONFIGURATION
 * =========================================================
 */

const PORT = process.env.PORT || config.port || 5000;

const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ||
  "http://localhost:5173,http://localhost:3000"
)
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);


/*
 * =========================================================
 * CORS
 * =========================================================
 *
 * Local:
 *   http://localhost:5173
 *   http://localhost:3000
 *
 * Production:
 *   Set ALLOWED_ORIGINS on Render to your Vercel URL.
 *
 * Example:
 *
 * ALLOWED_ORIGINS=https://your-frontend.vercel.app,http://localhost:5173
 */

app.use(
  cors({
    origin: (origin, callback) => {

      // Allow requests without an Origin header.
      // Useful for curl, Postman and server-to-server calls.
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.warn(
        `[CORS] Blocked origin: ${origin}`
      );

      return callback(
        new Error(`CORS blocked origin: ${origin}`)
      );
    },

    methods: [
      "GET",
      "POST",
      "OPTIONS"
    ],

    allowedHeaders: [
      "Content-Type",
      "Authorization"
    ]
  })
);


/*
 * =========================================================
 * BODY PARSER
 * =========================================================
 */

app.use(
  express.json({
    limit: "2mb"
  })
);


/*
 * =========================================================
 * ROOT
 * =========================================================
 *
 * Useful for checking the Render deployment.
 *
 * GET /
 */

app.get("/", (req, res) => {

  return res.status(200).json({
    status: "ok",
    service: "sih26143-node",
    message: "SIH26143 backend is running"
  });
});


/*
 * =========================================================
 * HEALTH CHECK
 * =========================================================
 *
 * GET /health
 */

app.get("/health", (req, res) => {

  return res.status(200).json({
    status: "ok",
    service: "sih26143-node",
    timestamp: new Date().toISOString()
  });
});


/*
 * =========================================================
 * RUN PIPELINE
 * =========================================================
 *
 * POST /api/run-pipeline
 *
 * Expected body:
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
 * Pipeline:
 *
 *   Node
 *     |
 *     +--> Python /detect
 *     |
 *     +--> Python /hindcast
 *     |
 *     +--> AIS CSV
 *     |
 *     +--> Dark vessel detection
 *     |
 *     +--> Kinematic reachability
 *     |
 *     +--> Attribution scoring
 *     |
 *     +--> Ranking
 *
 */

app.post("/api/run-pipeline", async (req, res) => {

  const startedAt = Date.now();

  try {

    console.log("");
    console.log("========================================");
    console.log("[PIPELINE] Starting");
    console.log("========================================");

    console.log(
      "[PIPELINE] Request:",
      JSON.stringify(req.body)
    );


    /*
     * Basic request validation
     *
     * Detailed validation is still handled by
     * pipeline.js according to the project contract.
     */

    if (!req.body || typeof req.body !== "object") {

      const error = new Error(
        "Request body must be a JSON object"
      );

      error.httpStatus = 422;
      error.failedStage = "validation";

      throw error;
    }


    /*
     * Run the complete pipeline.
     */

    const result = await runPipeline(req.body);


    const elapsedMs = Date.now() - startedAt;

    console.log(
      `[PIPELINE] Completed in ${elapsedMs} ms`
    );

    console.log("========================================");
    console.log("");


    return res.status(200).json(result);

  } catch (error) {

    const elapsedMs = Date.now() - startedAt;

    console.error("");
    console.error("========================================");
    console.error("[PIPELINE] FAILED");
    console.error("========================================");

    console.error(
      `[PIPELINE] Failed after ${elapsedMs} ms`
    );

    console.error(
      "[PIPELINE] Error:",
      error
    );


    /*
     * pipeline.js can provide:
     *
     * error.httpStatus
     * error.failedStage
     */

    const statusCode =
      Number.isInteger(error?.httpStatus)
        ? error.httpStatus
        : 500;


    const failedStage =
      error?.failedStage ||
      "attribution";


    return res
      .status(statusCode)
      .json({
        status: "error",

        message:
          error?.message ||
          "Pipeline failed",

        failed_stage: failedStage
      });
  }
});


/*
 * =========================================================
 * 404 HANDLER
 * =========================================================
 */

app.use((req, res) => {

  return res.status(404).json({
    status: "error",
    message:
      `Route not found: ${req.method} ${req.originalUrl}`
  });
});


/*
 * =========================================================
 * GLOBAL ERROR HANDLER
 * =========================================================
 */

app.use((error, req, res, next) => {

  console.error(
    "[SERVER] Unhandled error:",
    error
  );


  /*
   * CORS error
   */

  if (
    error?.message &&
    error.message.startsWith(
      "CORS blocked origin:"
    )
  ) {

    return res.status(403).json({
      status: "error",
      message: error.message
    });
  }


  /*
   * Generic server error
   */

  return res.status(500).json({
    status: "error",
    message: "Internal server error"
  });
});


/*
 * =========================================================
 * START SERVER
 * =========================================================
 */

app.listen(PORT, "0.0.0.0", () => {

  console.log("");
  console.log("========================================");
  console.log("SIH26143 Node.js Backend");
  console.log("========================================");

  console.log(
    `Server running on port ${PORT}`
  );

  console.log(
    `Python service: ${config.pythonServiceUrl}`
  );

  console.log(
    `Allowed origins: ${allowedOrigins.join(", ")}`
  );

  console.log("========================================");
  console.log("");
});