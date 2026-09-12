import crypto from "node:crypto";
import { centroid } from "@turf/turf";

import { config } from "../config.js";
import { loadAisCsv } from "../ais/loader.js";
import {
  findDarkVessels,
  rankSuspects
} from "../ais/attribution.js";
import {
  detect,
  hindcast
} from "./pythonClient.js";


/*
 * ---------------------------------------------------------
 * VALIDATION
 * ---------------------------------------------------------
 */

function validateRequest(body) {
  if (!body || typeof body !== "object") {
    const error = new Error("Request body is required");
    error.httpStatus = 422;
    error.failedStage = "detection";
    throw error;
  }

  const { region, date } = body;

  if (!region || typeof region !== "object") {
    const error = new Error("region is required");
    error.httpStatus = 422;
    error.failedStage = "detection";
    throw error;
  }

  const requiredRegionFields = [
    "min_lon",
    "min_lat",
    "max_lon",
    "max_lat"
  ];

  for (const field of requiredRegionFields) {
    if (
      typeof region[field] !== "number" ||
      !Number.isFinite(region[field])
    ) {
      const error = new Error(
        `region.${field} must be a valid number`
      );

      error.httpStatus = 422;
      error.failedStage = "detection";

      throw error;
    }
  }

  if (region.min_lon >= region.max_lon) {
    const error = new Error(
      "region.min_lon must be less than region.max_lon"
    );

    error.httpStatus = 422;
    error.failedStage = "detection";

    throw error;
  }

  if (region.min_lat >= region.max_lat) {
    const error = new Error(
      "region.min_lat must be less than region.max_lat"
    );

    error.httpStatus = 422;
    error.failedStage = "detection";

    throw error;
  }

  if (
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    const error = new Error(
      "date must be in YYYY-MM-DD format"
    );

    error.httpStatus = 422;
    error.failedStage = "detection";

    throw error;
  }

  const parsedDate = new Date(`${date}T00:00:00Z`);

  if (Number.isNaN(parsedDate.getTime())) {
    const error = new Error("Invalid date");
    error.httpStatus = 422;
    error.failedStage = "detection";
    throw error;
  }
}


/*
 * ---------------------------------------------------------
 * AIS REGION FILTER
 * ---------------------------------------------------------
 *
 * Keep only AIS records inside the requested bounding box.
 *
 * GeoJSON convention:
 * longitude = lon
 * latitude  = lat
 */

function filterAisByRegion(records, region) {
  return records.filter(record => {
    if (
      typeof record.lon !== "number" ||
      typeof record.lat !== "number"
    ) {
      return false;
    }

    return (
      record.lon >= region.min_lon &&
      record.lon <= region.max_lon &&
      record.lat >= region.min_lat &&
      record.lat <= region.max_lat
    );
  });
}


/*
 * ---------------------------------------------------------
 * AIS DATE FILTER
 * ---------------------------------------------------------
 *
 * Keep records belonging to the requested date.
 */

function filterAisByDate(records, date) {
  const start = new Date(`${date}T00:00:00Z`);
  const end = new Date(`${date}T23:59:59.999Z`);

  return records.filter(record => {
    const timestamp = new Date(record.timestamp);

    if (Number.isNaN(timestamp.getTime())) {
      return false;
    }

    return (
      timestamp >= start &&
      timestamp <= end
    );
  });
}


/*
 * ---------------------------------------------------------
 * PYTHON RESPONSE VALIDATION
 * ---------------------------------------------------------
 */

function validateDetectionResponse(detection) {
  if (!detection || typeof detection !== "object") {
    throw new Error(
      "Python /detect returned an invalid response"
    );
  }

  if (!detection.detection_id) {
    throw new Error(
      "Python /detect response missing detection_id"
    );
  }

  if (!detection.timestamp) {
    throw new Error(
      "Python /detect response missing timestamp"
    );
  }

  if (
    typeof detection.confidence !== "number"
  ) {
    throw new Error(
      "Python /detect response missing confidence"
    );
  }

  if (
    !detection.polygon ||
    detection.polygon.type !== "Polygon" ||
    !Array.isArray(detection.polygon.coordinates)
  ) {
    throw new Error(
      "Python /detect response contains invalid polygon"
    );
  }

  if (
    !detection.geometry ||
    !detection.geometry.centroid
  ) {
    throw new Error(
      "Python /detect response missing geometry.centroid"
    );
  }

  const { lon, lat } =
    detection.geometry.centroid;

  if (
    typeof lon !== "number" ||
    typeof lat !== "number"
  ) {
    throw new Error(
      "Python /detect centroid must contain numeric lon/lat"
    );
  }
}


function validateHindcastResponse(hindcastResult) {
  if (
    !hindcastResult ||
    typeof hindcastResult !== "object"
  ) {
    throw new Error(
      "Python /hindcast returned an invalid response"
    );
  }

  if (
    !hindcastResult.origin_probability_area ||
    hindcastResult.origin_probability_area.type !== "Polygon"
  ) {
    throw new Error(
      "Python /hindcast response missing origin_probability_area"
    );
  }

  if (
    !hindcastResult.estimated_origin_time_window ||
    !hindcastResult.estimated_origin_time_window.start ||
    !hindcastResult.estimated_origin_time_window.end
  ) {
    throw new Error(
      "Python /hindcast response missing estimated_origin_time_window"
    );
  }

  if (
    !hindcastResult.forward_forecast_path ||
    hindcastResult.forward_forecast_path.type !== "Polygon"
  ) {
    throw new Error(
      "Python /hindcast response missing forward_forecast_path"
    );
  }
}


/*
 * ---------------------------------------------------------
 * RUN ID
 * ---------------------------------------------------------
 */

function createRunId() {
  const randomPart =
    crypto.randomBytes(4).toString("hex");

  return `run_${Date.now()}_${randomPart}`;
}


/*
 * ---------------------------------------------------------
 * MAIN PIPELINE
 * ---------------------------------------------------------
 */

export async function runPipeline(body) {

  validateRequest(body);

  const {
    region,
    date
  } = body;

  const runId = createRunId();

  /*
   * -------------------------------------------------------
   * 1. OIL-SPILL DETECTION
   * -------------------------------------------------------
   */

  let detectionResult;

  try {

    console.log(
      `[${runId}] Calling Python /detect`
    );

    detectionResult = await detect({
      region,
      date
    });

    validateDetectionResponse(
      detectionResult
    );

  } catch (error) {

    console.error(
      `[${runId}] Detection failed:`,
      error.message
    );

    error.httpStatus = 502;
    error.failedStage = "detection";

    throw error;
  }


  /*
   * -------------------------------------------------------
   * 2. HINDCAST
   * -------------------------------------------------------
   */

  let hindcastResult;

  try {

    console.log(
      `[${runId}] Calling Python /hindcast`
    );

    hindcastResult = await hindcast({

      centroid:
        detectionResult.geometry.centroid,

      polygon:
        detectionResult.polygon,

      detection_timestamp:
        detectionResult.timestamp,

      region
    });

    validateHindcastResponse(
      hindcastResult
    );

  } catch (error) {

    console.error(
      `[${runId}] Hindcast failed:`,
      error.message
    );

    error.httpStatus = 502;
    error.failedStage = "hindcast";

    throw error;
  }


  /*
   * -------------------------------------------------------
   * 3. LOAD AIS
   * -------------------------------------------------------
   */

  let aisRecords;

  try {

    console.log(
      `[${runId}] Loading AIS data`
    );

    aisRecords =
      await loadAisCsv(
        config.aisCsvPath
      );

    console.log(
      `[${runId}] Loaded ${aisRecords.length} AIS records`
    );

  } catch (error) {

    console.error(
      `[${runId}] AIS loading failed:`,
      error.message
    );

    error.httpStatus = 500;
    error.failedStage = "attribution";

    throw error;
  }


  /*
   * -------------------------------------------------------
   * 4. FILTER AIS BY REGION
   * -------------------------------------------------------
   */

  const regionalAis =
    filterAisByRegion(
      aisRecords,
      region
    );

  console.log(
    `[${runId}] ${regionalAis.length} AIS records inside requested region`
  );


  /*
   * -------------------------------------------------------
   * 5. FILTER AIS BY DATE
   * -------------------------------------------------------
   */

  const relevantAis =
    filterAisByDate(
      regionalAis,
      date
    );

  console.log(
    `[${runId}] ${relevantAis.length} AIS records for ${date}`
  );


  /*
   * -------------------------------------------------------
   * 6. FIND ORIGIN AREA / TIME WINDOW
   * -------------------------------------------------------
   */

  const originArea =
    hindcastResult.origin_probability_area;

  const originWindow =
    hindcastResult.estimated_origin_time_window;


  /*
   * -------------------------------------------------------
   * 7. DARK VESSEL DETECTION
   * -------------------------------------------------------
   */

  let darkVessels;

  try {

    darkVessels =
      findDarkVessels(
        relevantAis,
        originArea,
        originWindow,
        75
      );

    console.log(
      `[${runId}] Found ${darkVessels.length} dark-vessel candidates`
    );

  } catch (error) {

    console.error(
      `[${runId}] Dark-vessel detection failed:`,
      error.message
    );

    error.httpStatus = 500;
    error.failedStage = "attribution";

    throw error;
  }


  /*
   * -------------------------------------------------------
   * 8. ORIGIN CENTROID
   * -------------------------------------------------------
   *
   * Use the centroid from the probability area.
   *
   * rankSuspects() expects:
   *
   * {
   *   lon,
   *   lat
   * }
   */

  const originCentroid =
    getPolygonCentroid(
      originArea
    );


  /*
   * -------------------------------------------------------
   * 9. RANK SUSPECTS
   * -------------------------------------------------------
   */

  let rankedSuspects;

  try {

    rankedSuspects =
      rankSuspects(
        darkVessels,
        originArea,
        originCentroid,
        originWindow
      );

    console.log(
      `[${runId}] Ranked ${rankedSuspects.length} suspects`
    );

  } catch (error) {

    console.error(
      `[${runId}] Attribution ranking failed:`,
      error.message
    );

    error.httpStatus = 500;
    error.failedStage = "attribution";

    throw error;
  }


  /*
   * -------------------------------------------------------
   * 10. RETURN EXACT FRONTEND CONTRACT
   * -------------------------------------------------------
   */

  return {

    run_id: runId,

    status: "success",

    generated_at:
      new Date().toISOString(),

    detection: {

      detection_id:
        detectionResult.detection_id,

      timestamp:
        detectionResult.timestamp,

      confidence:
        detectionResult.confidence,

      polygon:
        detectionResult.polygon,

      geometry:
        detectionResult.geometry

    },

    hindcast: {

      origin_probability_area:
        hindcastResult.origin_probability_area,

      estimated_origin_time_window:
        hindcastResult.estimated_origin_time_window,

      forward_forecast_path:
        hindcastResult.forward_forecast_path

    },

    ranked_suspects:
      rankedSuspects
  };
}


/*
 * ---------------------------------------------------------
 * GEOJSON POLYGON CENTROID
 * ---------------------------------------------------------
 *
 * We intentionally calculate this from the polygon
 * instead of assuming that Python gives us a separate
 * origin centroid.
 *
 * This uses a simple coordinate average suitable for
 * the relatively small origin polygons used here.
 */

function getPolygonCentroid(polygon) {
  const feature = {
    type: "Feature",
    properties: {},
    geometry: polygon
  };

  const center = centroid(feature);

  const [lon, lat] =
    center.geometry.coordinates;

  return {
    lon,
    lat
  };
}