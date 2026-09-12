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

    const error = new Error(
      "Request body is required"
    );

    error.httpStatus = 422;
    error.failedStage = "detection";

    throw error;
  }

  const {
    region,
    date
  } = body;


  if (!region || typeof region !== "object") {

    const error = new Error(
      "region is required"
    );

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


  const parsedDate =
    new Date(`${date}T00:00:00Z`);


  if (Number.isNaN(parsedDate.getTime())) {

    const error = new Error(
      "Invalid date"
    );

    error.httpStatus = 422;
    error.failedStage = "detection";

    throw error;
  }
}


/*
 * ---------------------------------------------------------
 * AIS DATE FILTER
 * ---------------------------------------------------------
 *
 * IMPORTANT:
 *
 * We intentionally DO NOT filter AIS by the satellite
 * detection bounding box.
 *
 * A vessel may have been outside the detected spill
 * region when its last AIS signal was received and
 * subsequently become dark.
 *
 * The attribution stage determines whether that vessel
 * could have reached the spill origin.
 */

function filterAisByDate(records, date) {

  const start =
    new Date(`${date}T00:00:00Z`);

  const end =
    new Date(`${date}T23:59:59.999Z`);


  return records.filter(record => {

    const timestamp =
      new Date(record.timestamp);


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
 * PYTHON DETECTION RESPONSE VALIDATION
 * ---------------------------------------------------------
 */

function validateDetectionResponse(detection) {

  if (
    !detection ||
    typeof detection !== "object"
  ) {

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
    !Array.isArray(
      detection.polygon.coordinates
    )
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


  const {
    lon,
    lat
  } = detection.geometry.centroid;


  if (
    typeof lon !== "number" ||
    typeof lat !== "number"
  ) {

    throw new Error(
      "Python /detect centroid must contain numeric lon/lat"
    );
  }
}


/*
 * ---------------------------------------------------------
 * PYTHON HINDCAST RESPONSE VALIDATION
 * ---------------------------------------------------------
 */

function validateHindcastResponse(
  hindcastResult
) {

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
    hindcastResult.origin_probability_area.type !==
      "Polygon"
  ) {

    throw new Error(
      "Python /hindcast response missing origin_probability_area"
    );
  }


  if (
    !hindcastResult.estimated_origin_time_window ||
    !hindcastResult
      .estimated_origin_time_window
      .start ||
    !hindcastResult
      .estimated_origin_time_window
      .end
  ) {

    throw new Error(
      "Python /hindcast response missing estimated_origin_time_window"
    );
  }


  if (
    !hindcastResult.forward_forecast_path ||
    hindcastResult.forward_forecast_path.type !==
      "Polygon"
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

  /*
   * Validate frontend request.
   */

  validateRequest(body);


  const {
    region,
    date
  } = body;


  const runId =
    createRunId();


  console.log("");
  console.log(
    "=================================================="
  );

  console.log(
    `[${runId}] PIPELINE STARTED`
  );

  console.log(
    `[${runId}] Date: ${date}`
  );

  console.log(
    `[${runId}] Region:`,
    JSON.stringify(region)
  );

  console.log(
    "=================================================="
  );


  /*
   * -------------------------------------------------------
   * 1. OIL-SPILL DETECTION
   * -------------------------------------------------------
   */

  let detectionResult;


  try {

    console.log(
      `[${runId}] [1/7] Calling Python /detect`
    );


    detectionResult =
      await detect({
        region,
        date
      });


    validateDetectionResponse(
      detectionResult
    );


    console.log(
      `[${runId}] Detection successful`
    );

    console.log(
      `[${runId}] Detection ID: ${detectionResult.detection_id}`
    );

    console.log(
      `[${runId}] Detection confidence: ${detectionResult.confidence}`
    );

    console.log(
      `[${runId}] Spill centroid:`,
      detectionResult.geometry.centroid
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
      `[${runId}] [2/7] Calling Python /hindcast`
    );


    hindcastResult =
      await hindcast({

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


    console.log(
      `[${runId}] Hindcast successful`
    );


    console.log(
      `[${runId}] Origin time window:`,
      JSON.stringify(
        hindcastResult
          .estimated_origin_time_window
      )
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
   * 3. LOAD ALL AIS DATA
   * -------------------------------------------------------
   *
   * DO NOT spatially restrict AIS here.
   *
   * We need historical AIS positions from outside the
   * satellite detection box because a dark vessel may
   * disappear before entering the spill region.
   */

  let aisRecords;


  try {

    console.log(
      `[${runId}] [3/7] Loading AIS data`
    );


    aisRecords =
      await loadAisCsv(
        config.aisCsvPath
      );


    console.log(
      `[${runId}] Loaded ${aisRecords.length} AIS records`
    );


    if (aisRecords.length === 0) {

      const error = new Error(
        "AIS dataset contains no valid records"
      );

      error.httpStatus = 500;
      error.failedStage = "attribution";

      throw error;
    }

  } catch (error) {

    console.error(
      `[${runId}] AIS loading failed:`,
      error.message
    );


    error.httpStatus =
      error.httpStatus || 500;

    error.failedStage =
      "attribution";


    throw error;
  }


  /*
   * -------------------------------------------------------
   * 4. FILTER AIS BY DATE ONLY
   * -------------------------------------------------------
   *
   * IMPORTANT CHANGE:
   *
   * Old code:
   *
   *   AIS -> region filter -> date filter
   *
   * New code:
   *
   *   AIS -> date filter -> attribution
   *
   * This prevents valid dark vessels from being removed
   * simply because their last AIS position was outside
   * the satellite bounding box.
   */

  const relevantAis =
    filterAisByDate(
      aisRecords,
      date
    );


  console.log(
    `[${runId}] [4/7] AIS records for ${date}: ${relevantAis.length}`
  );


  if (relevantAis.length === 0) {

    console.warn(
      `[${runId}] WARNING: No AIS records found for ${date}`
    );
  }


  /*
   * -------------------------------------------------------
   * 5. FIND ORIGIN AREA / TIME WINDOW
   * -------------------------------------------------------
   */

  const originArea =
    hindcastResult.origin_probability_area;


  const originWindow =
    hindcastResult
      .estimated_origin_time_window;


  console.log(
    `[${runId}] [5/7] Origin probability area ready`
  );


  console.log(
    `[${runId}] Origin time window:`,
    JSON.stringify(originWindow)
  );


  /*
   * -------------------------------------------------------
   * 6. DARK VESSEL DETECTION
   * -------------------------------------------------------
   */

  let darkVessels;


  try {

    console.log(
      `[${runId}] [6/7] Searching for dark vessels`
    );


    /*
     * Pass ALL date-relevant AIS records.
     *
     * attribution.js is responsible for:
     *
     *   - selecting last ping before origin
     *   - calculating dark gap
     *   - checking distance to origin
     *   - calculating reachable zone
     */

    darkVessels =
      findDarkVessels(
        relevantAis,
        originArea,
        originWindow,
        75
      );


    console.log(
      `[${runId}] Dark-vessel candidates: ${darkVessels.length}`
    );


    /*
     * Print candidates for debugging.
     */

    if (darkVessels.length > 0) {

      for (const vessel of darkVessels) {

        console.log(
          `[${runId}] Candidate:`,
          JSON.stringify({
            mmsi: vessel.mmsi,
            vessel_name:
              vessel.vessel_name,
            vessel_type:
              vessel.vessel_type,
            last_position: {
              lat: vessel.lat,
              lon: vessel.lon
            },
            went_dark_hours_ago:
              vessel.went_dark_hours_ago,
            distance_to_origin_km:
              vessel.distance_to_origin_km
          })
        );
      }

    } else {

      console.warn(
        `[${runId}] WARNING: No dark-vessel candidates found`
      );
    }

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
   * 7. ORIGIN CENTROID
   * -------------------------------------------------------
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


  console.log(
    `[${runId}] Origin centroid:`,
    originCentroid
  );


  /*
   * -------------------------------------------------------
   * 8. RANK SUSPECTS
   * -------------------------------------------------------
   */

  let rankedSuspects;


  try {

    console.log(
      `[${runId}] [7/7] Ranking suspects`
    );


    rankedSuspects =
      rankSuspects(
        darkVessels,
        originArea,
        originCentroid,
        originWindow
      );


    console.log(
      `[${runId}] Ranked suspects: ${rankedSuspects.length}`
    );


    /*
     * Print ranking for debugging.
     */

    for (
      const suspect of rankedSuspects
    ) {

      console.log(
        `[${runId}] Ranking:`,
        JSON.stringify({
          mmsi:
            suspect.mmsi,

          vessel_name:
            suspect.vessel_name,

          kinematic_score:
            suspect.kinematic_score,

          proximity_score:
            suspect.proximity_score,

          size_match_score:
            suspect.size_match_score,

          final_score:
            suspect.final_score
        })
      );
    }

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
   * FINAL RESPONSE
   * -------------------------------------------------------
   */

  const response = {

    run_id:
      runId,

    status:
      "success",

    generated_at:
      new Date().toISOString(),


    /*
     * Detection result from Python.
     */

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


    /*
     * Hindcast result from Python.
     */

    hindcast: {

      origin_probability_area:
        hindcastResult
          .origin_probability_area,

      estimated_origin_time_window:
        hindcastResult
          .estimated_origin_time_window,

      forward_forecast_path:
        hindcastResult
          .forward_forecast_path

    },


    /*
     * Final vessel ranking.
     */

    ranked_suspects:
      rankedSuspects

  };


  console.log("");
  console.log(
    "=================================================="
  );

  console.log(
    `[${runId}] PIPELINE COMPLETED`
  );

  console.log(
    `[${runId}] Final suspects: ${rankedSuspects.length}`
  );

  console.log(
    "=================================================="
  );
  console.log("");


  return response;
}


/*
 * ---------------------------------------------------------
 * GEOJSON POLYGON CENTROID
 * ---------------------------------------------------------
 *
 * Calculate centroid from the origin probability polygon.
 *
 * GeoJSON coordinates:
 *
 * [longitude, latitude]
 */

function getPolygonCentroid(polygon) {

  const feature = {

    type:
      "Feature",

    properties:
      {},

    geometry:
      polygon

  };


  const center =
    centroid(feature);


  const [
    lon,
    lat
  ] =
    center.geometry.coordinates;


  return {

    lon,
    lat

  };
}