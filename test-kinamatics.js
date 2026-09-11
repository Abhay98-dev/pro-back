import { loadAisCsv } from "./src/ais/loader.js";

import {
  findDarkVessels,
  calculateReachableZone,
  calculateKinematicScore
} from "./src/ais/attribution.js";


const records =
  await loadAisCsv("./data/ais.csv");


const originProbabilityArea = {
  type: "Polygon",

  coordinates: [[
    [72.40, 18.20],
    [72.55, 18.20],
    [72.55, 18.35],
    [72.40, 18.35],
    [72.40, 18.20]
  ]]
};


const originTimeWindow = {
  start: "2024-03-15T09:00:00Z",
  end: "2024-03-15T11:00:00Z"
};


const darkVessels =
  findDarkVessels(
    records,
    originProbabilityArea,
    originTimeWindow,
    75
  );


console.log(
  "\nDark vessels:",
  darkVessels.length
);


for (const vessel of darkVessels) {

  const reachableZone =
    calculateReachableZone(
      vessel,
      originTimeWindow
    );


  const score =
    calculateKinematicScore(
      reachableZone,
      originProbabilityArea
    );


  console.log("\n-------------------------");

  console.log(
    "Vessel:",
    vessel.vessel_name
  );

  console.log(
    "MMSI:",
    vessel.mmsi
  );

  console.log(
    "Last position:",
    vessel.lon,
    vessel.lat
  );

  console.log(
    "Speed:",
    vessel.speed_knots,
    "knots"
  );

  console.log(
    "Heading:",
    vessel.heading_deg,
    "degrees"
  );

  console.log(
    "Dark for:",
    vessel.went_dark_hours_ago,
    "hours"
  );

  console.log(
    "Kinematic score:",
    score.toFixed(4)
  );

  console.log(
    "Reachable zone:",
    JSON.stringify(
      reachableZone
    )
  );
}