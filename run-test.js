import { loadAisCsv }
  from "./src/ais/loader.js";

import {
  findDarkVessels,
  getOriginCentroid,
  rankSuspects
} from "./src/ais/attribution.js";


const records =
  await loadAisCsv(
    "./data/ais.csv"
  );


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

  start:
    "2024-03-15T09:00:00Z",

  end:
    "2024-03-15T11:00:00Z"
};


const originCentroid =
  getOriginCentroid(
    originProbabilityArea
  );


const darkVessels =
  findDarkVessels(

    records,

    originProbabilityArea,

    originTimeWindow,

    75

  );


console.log(
  `Dark candidates: ${darkVessels.length}`
);


const suspects =
  rankSuspects(

    darkVessels,

    originProbabilityArea,

    originCentroid,

    originTimeWindow

  );


console.log(
  "\nRANKED SUSPECTS\n"
);


console.table(

  suspects.map(vessel => ({

    MMSI:
      vessel.mmsi,

    Vessel:
      vessel.vessel_name,

    Type:
      vessel.vessel_type,

    Kinematic:
      vessel.kinematic_score,

    Proximity:
      vessel.proximity_score,

    Size:
      vessel.size_match_score,

    FINAL:
      vessel.final_score

  }))

);
