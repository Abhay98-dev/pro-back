import {
  centroid,
  distance,
  destination,
  intersect,
  area
} from "@turf/turf";

const KNOT_TO_KM_H = 1.852;

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function hoursBetween(start, end) {
  return (
    (new Date(end).getTime() -
      new Date(start).getTime()) /
    (1000 * 60 * 60)
  );
}

/*
 * Get latest AIS ping for every vessel.
 */
export function getLatestPings(records) {
  const latest = new Map();

  for (const record of records) {
    if (!record?.mmsi || !record?.timestamp) {
      continue;
    }

    const existing = latest.get(record.mmsi);

    if (
      !existing ||
      new Date(record.timestamp) >
        new Date(existing.timestamp)
    ) {
      latest.set(record.mmsi, record);
    }
  }

  return [...latest.values()];
}

/*
 * Find the last AIS ping before the estimated
 * spill-origin window.
 *
 * We intentionally DO NOT restrict AIS by the
 * satellite detection bounding box.
 */
export function getLastPingBeforeOrigin(
  records,
  originTimeWindow
) {
  const originStart =
    new Date(originTimeWindow.start);

  const vesselPings = new Map();

  for (const record of records) {
    if (
      !record?.mmsi ||
      !record?.timestamp ||
      record.lat === null ||
      record.lon === null
    ) {
      continue;
    }

    const timestamp =
      new Date(record.timestamp);

    if (Number.isNaN(timestamp.getTime())) {
      continue;
    }

    /*
     * Only consider AIS transmissions before
     * the estimated origin window begins.
     */
    if (timestamp >= originStart) {
      continue;
    }

    const existing =
      vesselPings.get(record.mmsi);

    if (
      !existing ||
      timestamp >
        new Date(existing.timestamp)
    ) {
      vesselPings.set(
        record.mmsi,
        record
      );
    }
  }

  return [...vesselPings.values()];
}

/*
 * Get centroid of origin probability area.
 */
export function getOriginCentroid(
  originProbabilityArea
) {
  const feature = {
    type: "Feature",
    properties: {},
    geometry: originProbabilityArea
  };

  const result =
    centroid(feature);

  return {
    lon:
      result.geometry.coordinates[0],

    lat:
      result.geometry.coordinates[1]
  };
}

/*
 * Check whether a vessel's dark period overlaps
 * the estimated spill-origin time window.
 *
 * Example:
 *
 * Last AIS ping:       06:30
 * Dark requirement:    2–3 hours
 *
 * Dark interval:
 *   08:30 → 09:30
 *
 * Origin window:
 *   07:30 → 10:30
 *
 * These intervals overlap, so the vessel is a
 * valid temporal candidate.
 */
function getDarkWindowOverlap(
  lastPing,
  originTimeWindow
) {
  const lastPingTime =
    new Date(lastPing);

  const originStart =
    new Date(originTimeWindow.start);

  const originEnd =
    new Date(originTimeWindow.end);

  /*
   * A vessel is considered dark for the
   * 2–3 hour interval following its last AIS ping.
   */
  const darkWindowStart =
    new Date(
      lastPingTime.getTime() +
        2 * 60 * 60 * 1000
    );

  const darkWindowEnd =
    new Date(
      lastPingTime.getTime() +
        3 * 60 * 60 * 1000
    );

  /*
   * Check whether:
   *
   * [dark start, dark end]
   *
   * overlaps:
   *
   * [origin start, origin end]
   */
  const overlapStart =
    Math.max(
      darkWindowStart.getTime(),
      originStart.getTime()
    );

  const overlapEnd =
    Math.min(
      darkWindowEnd.getTime(),
      originEnd.getTime()
    );

  if (overlapStart > overlapEnd) {
    return null;
  }

  /*
   * Use the midpoint of the overlapping interval
   * as the representative origin time.
   */
  const representativeTime =
    new Date(
      (overlapStart + overlapEnd) / 2
    );

  const darkHours =
    hoursBetween(
      lastPingTime,
      representativeTime
    );

  return {
    darkWindowStart,
    darkWindowEnd,
    representativeTime,
    darkHours
  };
}

/*
 * DARK VESSEL DETECTION
 *
 * Candidate requirements:
 *
 * 1. Last AIS ping occurred before origin window.
 *
 * 2. The vessel's 2–3 hour dark interval overlaps
 *    the estimated spill-origin time window.
 *
 * 3. Last known position is within the allowed
 *    distance from the estimated origin centroid.
 *
 * IMPORTANT:
 *
 * We DO NOT filter AIS by the satellite detection
 * bounding box.
 */
export function findDarkVessels(
  records,
  originProbabilityArea,
  originTimeWindow,
  radiusKm = 75
) {
  if (
    !Array.isArray(records) ||
    records.length === 0
  ) {
    console.warn(
      "[AIS] No AIS records available."
    );

    return [];
  }

  if (
    !originProbabilityArea ||
    !originTimeWindow?.start ||
    !originTimeWindow?.end
  ) {
    console.warn(
      "[AIS] Missing origin probability area or origin time window."
    );

    return [];
  }

  const originCentroid =
    getOriginCentroid(
      originProbabilityArea
    );

  /*
   * Get the last AIS transmission for every
   * vessel before the origin window.
   */
  const latestBeforeOrigin =
    getLastPingBeforeOrigin(
      records,
      originTimeWindow
    );

  console.log(
    `[AIS] Unique vessels before origin: ${latestBeforeOrigin.length}`
  );

  console.log(
    `[AIS] Origin window: ${originTimeWindow.start} → ${originTimeWindow.end}`
  );

  const candidates = [];

  for (
    const vessel of latestBeforeOrigin
  ) {
    const lastPing =
      new Date(vessel.timestamp);

    /*
     * -----------------------------------------------------
     * TEMPORAL CHECK
     * -----------------------------------------------------
     *
     * Instead of comparing only with originWindow.start,
     * determine whether the 2–3 hour dark interval overlaps
     * ANY part of the origin window.
     */
    const darkWindow =
      getDarkWindowOverlap(
        vessel.timestamp,
        originTimeWindow
      );

    /*
     * Distance from last known AIS position
     * to estimated origin centroid.
     */
    const distanceKm =
      distance(
        [
          vessel.lon,
          vessel.lat
        ],
        [
          originCentroid.lon,
          originCentroid.lat
        ],
        {
          units: "kilometers"
        }
      );

    console.log(
      `[AIS] ${vessel.mmsi} | ` +
      `${vessel.vessel_name ?? "Unknown"} | ` +
      `last=${vessel.timestamp} | ` +
      `distance=${distanceKm.toFixed(2)}km`
    );

    /*
     * -----------------------------------------------------
     * TEMPORAL REJECTION
     * -----------------------------------------------------
     */
    if (!darkWindow) {
      console.log(
        `[AIS] REJECT ${vessel.mmsi}: ` +
        `2–3h dark interval does not overlap origin window`
      );

      continue;
    }

    console.log(
      `[AIS] ${vessel.mmsi} | ` +
      `dark interval=` +
      `${darkWindow.darkWindowStart.toISOString()} → ` +
      `${darkWindow.darkWindowEnd.toISOString()} | ` +
      `representative dark gap=` +
      `${darkWindow.darkHours.toFixed(2)}h`
    );

    /*
     * -----------------------------------------------------
     * DISTANCE REJECTION
     * -----------------------------------------------------
     */
    if (distanceKm > radiusKm) {
      console.log(
        `[AIS] REJECT ${vessel.mmsi}: ` +
        `${distanceKm.toFixed(2)}km > ${radiusKm}km`
      );

      continue;
    }

    /*
     * -----------------------------------------------------
     * ACCEPT
     * -----------------------------------------------------
     */
    console.log(
      `[AIS] ACCEPT ${vessel.mmsi}: dark vessel candidate`
    );

    candidates.push({
      ...vessel,

      /*
       * Representative dark gap inside the
       * uncertain origin window.
       */
      went_dark_hours_ago:
        Number(
          darkWindow.darkHours.toFixed(2)
        ),

      distance_to_origin_km:
        Number(
          distanceKm.toFixed(2)
        ),

      /*
       * Useful for frontend/debugging.
       */
      dark_window_start:
        darkWindow.darkWindowStart.toISOString(),

      dark_window_end:
        darkWindow.darkWindowEnd.toISOString(),

      representative_origin_time:
        darkWindow.representativeTime.toISOString()
    });
  }

  console.log(
    `[AIS] Dark vessel candidates: ${candidates.length}`
  );

  return candidates;
}

/*
 * Calculate reachable zone.
 *
 * Speed uncertainty: ±30%
 * Heading uncertainty: ±35°
 */
export function calculateReachableZone(
  vessel,
  originTimeWindow
) {
  /*
   * Use the beginning of the origin window for
   * the conservative reachability calculation.
   */
  const elapsedHours =
    hoursBetween(
      vessel.timestamp,
      originTimeWindow.start
    );

  if (elapsedHours <= 0) {
    return null;
  }

  const speed =
    Math.max(
      0,
      vessel.speed_knots ?? 0
    );

  const heading =
    Number.isFinite(
      vessel.heading_deg
    )
      ? vessel.heading_deg
      : 0;

  const speedKmH =
    speed * KNOT_TO_KM_H;

  const minDistance =
    speedKmH *
    0.7 *
    elapsedHours;

  const maxDistance =
    speedKmH *
    1.3 *
    elapsedHours;

  /*
   * Zero-speed vessel.
   */
  if (maxDistance === 0) {
    return {
      type: "Polygon",

      coordinates: [[
        [
          vessel.lon,
          vessel.lat
        ],

        [
          vessel.lon + 0.0001,
          vessel.lat
        ],

        [
          vessel.lon,
          vessel.lat + 0.0001
        ],

        [
          vessel.lon,
          vessel.lat
        ]
      ]]
    };
  }

  const outerPoints = [];

  for (
    let angle = heading - 35;
    angle <= heading + 35;
    angle += 5
  ) {
    const point =
      destination(
        [
          vessel.lon,
          vessel.lat
        ],

        maxDistance,

        angle,

        {
          units: "kilometers"
        }
      );

    outerPoints.push(
      point.geometry.coordinates
    );
  }

  const innerPoints = [];

  for (
    let angle = heading + 35;
    angle >= heading - 35;
    angle -= 5
  ) {
    const point =
      destination(
        [
          vessel.lon,
          vessel.lat
        ],

        minDistance,

        angle,

        {
          units: "kilometers"
        }
      );

    innerPoints.push(
      point.geometry.coordinates
    );
  }

  const coordinates = [
    [
      vessel.lon,
      vessel.lat
    ],

    ...outerPoints,

    ...innerPoints,

    [
      vessel.lon,
      vessel.lat
    ]
  ];

  return {
    type: "Polygon",
    coordinates: [coordinates]
  };
}

/*
 * KINEMATIC SCORE
 *
 * Score =
 *
 * intersection area /
 * origin probability area
 *
 * Range: 0–1
 */
export function calculateKinematicScore(
  reachableZone,
  originProbabilityArea
) {
  if (!reachableZone) {
    return 0;
  }

  try {
    const reachableFeature = {
      type: "Feature",
      properties: {},
      geometry: reachableZone
    };

    const originFeature = {
      type: "Feature",
      properties: {},
      geometry:
        originProbabilityArea
    };

    const originArea =
      area(originFeature);

    if (originArea <= 0) {
      return 0;
    }

    const overlap =
      intersect({
        type: "FeatureCollection",

        features: [
          reachableFeature,
          originFeature
        ]
      });

    if (!overlap) {
      return 0;
    }

    const overlapArea =
      area(overlap);

    return clamp01(
      overlapArea / originArea
    );

  } catch (error) {
    console.error(
      "[KRS] Intersection error:",
      error.message
    );

    return 0;
  }
}

/*
 * PROXIMITY SCORE
 */
export function calculateProximityScore(
  vessel,
  originCentroid
) {
  const distanceKm =
    distance(
      [
        vessel.lon,
        vessel.lat
      ],
      [
        originCentroid.lon,
        originCentroid.lat
      ],
      {
        units: "kilometers"
      }
    );

  const score =
    1 /
    (1 + distanceKm / 25);

  return {
    distanceKm:
      Number(
        distanceKm.toFixed(2)
      ),

    score:
      Number(
        clamp01(score).toFixed(4)
      )
  };
}

/*
 * SIZE / TYPE MATCH
 */
export function calculateSizeMatchScore(
  vessel,
  expectedVesselType = null
) {
  if (!expectedVesselType) {
    return 0.5;
  }

  if (!vessel.vessel_type) {
    return 0.5;
  }

  const actual =
    vessel.vessel_type
      .toLowerCase()
      .trim();

  const expected =
    expectedVesselType
      .toLowerCase()
      .trim();

  if (actual === expected) {
    return 1.0;
  }

  return 0.5;
}

/*
 * FINAL SUSPECT RANKING
 *
 * REQUIRED SIH FORMULA:
 *
 * 0.4 × Kinematic
 * 0.3 × Proximity
 * 0.3 × Size/Type
 */
export function rankSuspects(
  darkVessels,
  originProbabilityArea,
  originCentroid,
  originTimeWindow,
  expectedVesselType = null
) {
  return darkVessels
    .map(vessel => {

      const reachableZone =
        calculateReachableZone(
          vessel,
          originTimeWindow
        );

      const kinematicScore =
        calculateKinematicScore(
          reachableZone,
          originProbabilityArea
        );

      const proximity =
        calculateProximityScore(
          vessel,
          originCentroid
        );

      const sizeMatch =
        calculateSizeMatchScore(
          vessel,
          expectedVesselType
        );

      /*
       * DO NOT CHANGE THIS FORMULA.
       */
      const finalScore =
        0.4 * kinematicScore +
        0.3 * proximity.score +
        0.3 * sizeMatch;

      return {
        mmsi:
          vessel.mmsi,

        vessel_name:
          vessel.vessel_name,

        vessel_type:
          vessel.vessel_type,

        last_known_position: {
          lon:
            vessel.lon,

          lat:
            vessel.lat
        },

        last_known_timestamp:
          vessel.timestamp,

        last_known_speed_knots:
          vessel.speed_knots,

        last_known_heading_deg:
          vessel.heading_deg,

        went_dark_hours_ago:
          vessel.went_dark_hours_ago,

        reachable_zone:
          reachableZone,

        kinematic_score:
          Number(
            kinematicScore.toFixed(4)
          ),

        proximity_score:
          proximity.score,

        size_match_score:
          Number(
            sizeMatch.toFixed(4)
          ),

        final_score:
          Number(
            finalScore.toFixed(4)
          )
      };
    })

    .sort(
      (a, b) =>
        b.final_score -
        a.final_score
    );
}