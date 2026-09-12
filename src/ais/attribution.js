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
    (new Date(end).getTime() - new Date(start).getTime()) /
    (1000 * 60 * 60)
  );
}

/*
 * Get latest AIS ping for every vessel.
 */
export function getLatestPings(records) {
  const latest = new Map();

  for (const record of records) {
    if (!record?.mmsi || !record?.timestamp) continue;

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
 * IMPORTANT:
 *
 * Find the last AIS ping that occurred BEFORE
 * the estimated spill-origin window.
 *
 * We do NOT restrict this to the requested
 * satellite detection bounding box.
 */
export function getLastPingBeforeOrigin(records, originTimeWindow) {
  const originStart = new Date(originTimeWindow.start);

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

    const timestamp = new Date(record.timestamp);

    if (Number.isNaN(timestamp.getTime())) continue;

    /*
     * Only consider AIS transmissions before
     * the estimated origin time.
     */
    if (timestamp >= originStart) continue;

    const existing = vesselPings.get(record.mmsi);

    if (
      !existing ||
      timestamp > new Date(existing.timestamp)
    ) {
      vesselPings.set(record.mmsi, record);
    }
  }

  return [...vesselPings.values()];
}

/*
 * Get centroid of origin probability area.
 */
export function getOriginCentroid(originProbabilityArea) {
  const feature = {
    type: "Feature",
    properties: {},
    geometry: originProbabilityArea
  };

  const result = centroid(feature);

  return {
    lon: result.geometry.coordinates[0],
    lat: result.geometry.coordinates[1]
  };
}

/*
 * DARK VESSEL DETECTION
 *
 * A vessel is considered a candidate when:
 *
 * 1. Its last AIS transmission occurred before
 *    the estimated origin window.
 *
 * 2. It went dark approximately 2–3 hours before
 *    the origin window.
 *
 * 3. Its last known position is reasonably close
 *    to the estimated origin.
 *
 * IMPORTANT:
 * We intentionally do NOT use the satellite detection
 * bounding box here.
 */
export function findDarkVessels(
  records,
  originProbabilityArea,
  originTimeWindow,
  radiusKm = 75
) {
  if (!Array.isArray(records) || records.length === 0) {
    console.warn("[AIS] No AIS records available.");
    return [];
  }

  if (
    !originProbabilityArea ||
    !originTimeWindow?.start
  ) {
    console.warn(
      "[AIS] Missing origin probability area or origin time window."
    );
    return [];
  }

  const originCentroid =
    getOriginCentroid(originProbabilityArea);

  /*
   * Use the latest ping BEFORE the estimated origin.
   *
   * This is much better than blindly using the latest
   * ping in the entire CSV.
   */
  const latestBeforeOrigin =
    getLastPingBeforeOrigin(
      records,
      originTimeWindow
    );

  console.log(
    `[AIS] Unique vessels before origin: ${latestBeforeOrigin.length}`
  );

  const candidates = [];

  for (const vessel of latestBeforeOrigin) {
    const lastPing =
      new Date(vessel.timestamp);

    const darkHours =
      hoursBetween(
        lastPing,
        originTimeWindow.start
      );

    const distanceKm =
      distance(
        [vessel.lon, vessel.lat],
        [
          originCentroid.lon,
          originCentroid.lat
        ],
        {
          units: "kilometers"
        }
      );

    console.log(
      `[AIS] ${vessel.mmsi} | ${vessel.vessel_name ?? "Unknown"} | ` +
      `last=${vessel.timestamp} | ` +
      `dark=${darkHours.toFixed(2)}h | ` +
      `distance=${distanceKm.toFixed(2)}km`
    );

    /*
     * Dark-window requirement.
     */
    if (darkHours < 2 || darkHours > 3) {
      console.log(
        `[AIS] REJECT ${vessel.mmsi}: dark time outside 2–3h`
      );
      continue;
    }

    /*
     * Spatial proximity requirement.
     *
     * This is measured against the estimated origin,
     * NOT the original satellite bounding box.
     */
    if (distanceKm > radiusKm) {
      console.log(
        `[AIS] REJECT ${vessel.mmsi}: ${distanceKm.toFixed(2)}km > ${radiusKm}km`
      );
      continue;
    }

    console.log(
      `[AIS] ACCEPT ${vessel.mmsi}: dark vessel candidate`
    );

    candidates.push({
      ...vessel,

      went_dark_hours_ago:
        Number(
          darkHours.toFixed(2)
        ),

      distance_to_origin_km:
        Number(
          distanceKm.toFixed(2)
        )
    });
  }

  console.log(
    `[AIS] Dark vessel candidates: ${candidates.length}`
  );

  return candidates;
}

/*
 * Calculate reachable zone using:
 *
 * speed uncertainty ±30%
 * heading uncertainty ±35°
 */
export function calculateReachableZone(
  vessel,
  originTimeWindow
) {
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
        [vessel.lon, vessel.lat],
        [vessel.lon + 0.0001, vessel.lat],
        [vessel.lon, vessel.lat + 0.0001],
        [vessel.lon, vessel.lat]
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
        [vessel.lon, vessel.lat],
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
        [vessel.lon, vessel.lat],
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
    [vessel.lon, vessel.lat],
    ...outerPoints,
    ...innerPoints,
    [vessel.lon, vessel.lat]
  ];

  return {
    type: "Polygon",
    coordinates: [coordinates]
  };
}

/*
 * KINEMATIC SCORE
 *
 * overlap between reachable zone
 * and origin probability area.
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
      geometry: originProbabilityArea
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
      [vessel.lon, vessel.lat],
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
 * 0.4 Kinematic
 * 0.3 Proximity
 * 0.3 Size
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
          lon: vessel.lon,
          lat: vessel.lat
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