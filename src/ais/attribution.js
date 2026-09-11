import {
  centroid,
  distance,
  destination,
  intersect,
  area
} from "@turf/turf";

const KNOT_TO_KM_H = 1.852;


/* ---------------------------------------
   Utility functions
--------------------------------------- */

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}


function hoursBetween(start, end) {
  return (
    new Date(end).getTime() -
    new Date(start).getTime()
  ) / (1000 * 60 * 60);
}


/* ---------------------------------------
   Latest AIS position for each vessel
--------------------------------------- */

export function getLatestPings(records) {

  const latest = new Map();

  for (const record of records) {

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


/* ---------------------------------------
   Origin centroid
--------------------------------------- */

export function getOriginCentroid(
  originProbabilityArea
) {

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


/* ---------------------------------------
   DARK VESSEL DETECTION
--------------------------------------- */

export function findDarkVessels(
  records,
  originProbabilityArea,
  originTimeWindow,
  radiusKm = 75
) {

  const latestPings =
    getLatestPings(records);

  const originCentroid =
    getOriginCentroid(
      originProbabilityArea
    );

  const originStart =
    new Date(originTimeWindow.start);

  const candidates = [];

  for (const vessel of latestPings) {

    const lastPing =
      new Date(vessel.timestamp);


    /*
     * How long before the estimated
     * origin window did the vessel
     * stop transmitting AIS?
     */
    const darkHours =
      hoursBetween(
        lastPing,
        originStart
      );


    /*
     * SIH26143 requirement:
     *
     * last AIS ping must be
     * 2–3 hours before origin window.
     */
    if (
      darkHours < 2 ||
      darkHours > 3
    ) {
      continue;
    }


    /*
     * Distance from last known
     * position to origin centroid.
     */
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


    /*
     * Reject vessels that are too far away.
     */
    if (distanceKm > radiusKm) {
      continue;
    }


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

  return candidates;
}


/* ---------------------------------------
   REACHABLE ZONE
--------------------------------------- */

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


  /*
   * knots → km/hour
   */
  const speedKmH =
    speed * KNOT_TO_KM_H;


  /*
   * Speed uncertainty:
   *
   * -30% → 70%
   * +30% → 130%
   */
  const minDistance =
    speedKmH *
    0.7 *
    elapsedHours;

  const maxDistance =
    speedKmH *
    1.3 *
    elapsedHours;


  /*
   * Heading uncertainty:
   *
   * heading ±35°
   */
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


  /*
   * Inner boundary.
   *
   * Reverse order so the polygon
   * closes correctly.
   */
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


  /*
   * Build polygon.
   */
  let coordinates = [
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


  /*
   * Zero-speed case.
   */
  if (maxDistance === 0) {

    coordinates = [
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
    ];
  }


  return {
    type: "Polygon",
    coordinates: [
      coordinates
    ]
  };
}


/* ---------------------------------------
   KINEMATIC SCORE
--------------------------------------- */

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
      "Kinematic overlap error:",
      error.message
    );

    return 0;
  }
}

/* ---------------------------------------
   PROXIMITY SCORE
--------------------------------------- */

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


  /*
   * Inverse-distance score.
   *
   * 0 km  → 1.0
   * farther away → lower score
   */
  const score =
    1 / (1 + distanceKm / 25);


  return {
    distanceKm:
      Number(distanceKm.toFixed(2)),

    score:
      Number(
        clamp01(score).toFixed(4)
      )
  };
}


/* ---------------------------------------
   SIZE MATCH SCORE
--------------------------------------- */

export function calculateSizeMatchScore(
  vessel,
  expectedVesselType = null
) {

  /*
   * Tier-1 MVP:
   *
   * If SAR vessel-size information is
   * unavailable, specification requires
   * 0.5.
   */
  if (!expectedVesselType) {
    return 0.5;
  }


  if (!vessel.vessel_type) {
    return 0.5;
  }


  /*
   * Simple MVP type comparison.
   *
   * This is NOT an ML classifier.
   */
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


/* ---------------------------------------
   FINAL SUSPECT RANKING
--------------------------------------- */

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
        (
          0.4 * kinematicScore
        ) +
        (
          0.3 * proximity.score
        ) +
        (
          0.3 * sizeMatch
        );


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