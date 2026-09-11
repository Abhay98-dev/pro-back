import { loadAisCsv } from "./src/ais/loader.js";
import {
  findDarkVessels
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


const candidates =
  findDarkVessels(
    records,
    originProbabilityArea,
    originTimeWindow,
    75
  );


console.log("\nDARK VESSEL CANDIDATES\n");
console.table(candidates);