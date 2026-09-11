import fs from "node:fs/promises";
import { parse } from "csv-parse/sync";

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeAisRow(row) {
  const rawTimestamp =
    row.timestamp ??
    row.time ??
    row.datetime ??
    row.base_date_time;

  const timestamp = rawTimestamp
    ? new Date(rawTimestamp).toISOString()
    : null;

  return {
    mmsi: String(row.mmsi ?? row.MMSI ?? "").trim(),

    vessel_name:
      row.vessel_name ??
      row.ship_name ??
      row.name ??
      null,

    vessel_type:
      row.vessel_type ??
      row.ship_type ??
      row.type ??
      null,

    timestamp,

    lat: number(row.lat ?? row.latitude),
    lon: number(row.lon ?? row.longitude),

    speed_knots: number(
      row.speed_knots ??
      row.sog ??
      row.speed
    ),

    heading_deg: number(
      row.heading_deg ??
      row.cog ??
      row.heading
    )
  };
}

export async function loadAisCsv(filePath) {
  const csv = await fs.readFile(filePath, "utf8");

  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  return rows
    .map(normalizeAisRow)
    .filter(vessel =>
      vessel.mmsi &&
      vessel.timestamp &&
      vessel.lat !== null &&
      vessel.lon !== null
    );
}