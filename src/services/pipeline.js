import { config } from "../config.js";

import {
  detect,
  hindcast
} from "./pythonClient.js";

import {
  loadAisCsv
} from "../ais/loader.js";

import {
  findDarkVessels,
  getOriginCentroid,
  rankSuspects
} from "../ais/attribution.js";


/* ---------------------------------------
   Request validation
--------------------------------------- */

function validateRequest(body) {

  if (!body) {
    return "Request body is required";
  }


  if (!body.region) {
    return "region is required";
  }


  if (!body.date) {
    return "date is required";
  }


  const {
    min_lon,
    min_lat,
    max_lon,
    max_lat
  } = body.region;


  const values = [
    min_lon,
    min_lat,
    max_lon,
    max_lat
  ];


  if (
    values.some(
      value =>
        !Number.isFinite(
          Number(value)
        )
    )
  ) {
    return (
      "region must contain " +
      "numeric min_lon, min_lat, " +
      "max_lon and max_lat"
    );
  }


  if (
    Number(min_lon) >= Number(max_lon) ||
    Number(min_lat) >= Number(max_lat)
  ) {
    return "Invalid region bounds";
  }


  if (
    !/^\d{4}-\d{2}-\d{2}$/
      .test(body.date)
  ) {
    return "date must be YYYY-MM-DD";
  }


  return null;
}


/* ---------------------------------------
   Main pipeline
--------------------------------------- */

export async function runPipeline(body) {

  /*
   * Validate request
   */
  const validationError =
    validateRequest(body);


  if (validationError) {

    const error =
      new Error(validationError);

    error.httpStatus = 422;
    error.failedStage = "detection";

    throw error;
  }


  const region = {

    min_lon:
      Number(body.region.min_lon),

    min_lat:
      Number(body.region.min_lat),

    max_lon:
      Number(body.region.max_lon),

    max_lat:
      Number(body.region.max_lat)

  };


  /* -------------------------------------
     STEP 1
     Satellite detection
  ------------------------------------- */

  let detection;

  try {

    detection =
      await detect({
        region,
        date: body.date
      });

  } catch (error) {

    const wrapped =
      new Error(
        `Detection service failed: ${error.message}`
      );

    wrapped.httpStatus = 502;
    wrapped.failedStage = "detection";

    throw wrapped;
  }


  /* -------------------------------------
     STEP 2
     Hindcast
  ------------------------------------- */

  let hindcastResult;

  try {

    hindcastResult =
      await hindcast({

        centroid:
          detection.geometry.centroid,

        polygon:
          detection.polygon,

        detection_timestamp:
          detection.timestamp,

        region

      });

  } catch (error) {

    const wrapped =
      new Error(
        `Hindcast service failed: ${error.message}`
      );

    wrapped.httpStatus = 502;
    wrapped.failedStage = "hindcast";

    throw wrapped;
  }


  /* -------------------------------------
     STEP 3
     Load AIS
  ------------------------------------- */

  let aisRecords;

  try {

    aisRecords =
      await loadAisCsv(
        config.aisCsvPath
      );

  } catch (error) {

    const wrapped =
      new Error(
        `AIS loading failed: ${error.message}`
      );

    wrapped.httpStatus = 500;
    wrapped.failedStage = "attribution";

    throw wrapped;
  }


  /* -------------------------------------
     STEP 4
     Find dark vessels
  ------------------------------------- */

  try {

    const originArea =
      hindcastResult
        .origin_probability_area;


    const originWindow =
      hindcastResult
        .estimated_origin_time_window;


    const originCentroid =
      getOriginCentroid(
        originArea
      );


    const darkVessels =
      findDarkVessels(

        aisRecords,

        originArea,

        originWindow,

        75

      );


    /* -----------------------------------
       STEP 5
       Rank suspects
    ----------------------------------- */

    const rankedSuspects =
      rankSuspects(

        darkVessels,

        originArea,

        originCentroid,

        originWindow

      );


    /* -----------------------------------
       FINAL RESPONSE
    ----------------------------------- */

    return {

      run_id:
        `run_${body.date.replaceAll("-", "")}_${Date.now()}`,

      status:
        "success",

      generated_at:
        new Date().toISOString(),

      detection,

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

      ranked_suspects:
        rankedSuspects

    };

  } catch (error) {

    if (error.failedStage) {
      throw error;
    }

    const wrapped =
      new Error(
        `Attribution failed: ${error.message}`
      );

    wrapped.httpStatus = 500;
    wrapped.failedStage = "attribution";

    throw wrapped;
  }
}
