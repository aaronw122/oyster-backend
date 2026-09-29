// Regenerates src/builtins/data/mta-stops.json from MTA static data.
//
// Usage:
//   curl -L -o gtfs_subway.zip https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip && unzip -d gtfs gtfs_subway.zip
//   curl -L -o stations.csv "https://data.ny.gov/api/views/39hk-dx4f/rows.csv?accessType=DOWNLOAD"
//   bun run scripts/build-mta-stops.ts gtfs stations.csv
//
// Stations come from GTFS `stops.txt` (parent stations; platforms are the
// parent id + "N"/"S"). Routes are every route with a scheduled stop there
// (`stop_times.txt` ⋈ `trips.txt`). Direction labels ("Manhattan", "Uptown & The
// Bronx", …) come from the MTA Subway Stations dataset on data.ny.gov.
import { join } from "node:path";
import { baseLine, type MtaStation } from "../src/builtins/mta-lines.ts";

const [gtfsDir, stationsCsv] = process.argv.slice(2);
if (!gtfsDir || !stationsCsv) {
  console.error("usage: bun run scripts/build-mta-stops.ts <gtfs dir> <stations.csv>");
  process.exit(1);
}

function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((cell) => cell !== "")) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((cells) => Object.fromEntries(header.map((name, index) => [name.trim(), cells[index] ?? ""])));
}

const readCsv = async (path: string) => parseCsv(await Bun.file(path).text());

const routeByTrip = new Map<string, string>();
for (const trip of await readCsv(join(gtfsDir, "trips.txt"))) routeByTrip.set(trip.trip_id!, baseLine(trip.route_id!));

const routesByStation = new Map<string, Set<string>>();
for (const stopTime of await readCsv(join(gtfsDir, "stop_times.txt"))) {
  const route = routeByTrip.get(stopTime.trip_id!);
  if (route === undefined) continue;
  const station = stopTime.stop_id!.replace(/[NS]$/, "");
  let routes = routesByStation.get(station);
  if (!routes) routesByStation.set(station, (routes = new Set()));
  routes.add(route);
}

const labelsByStation = new Map<string, { north: string; south: string }>();
for (const row of await readCsv(stationsCsv)) {
  labelsByStation.set(row["GTFS Stop ID"]!, {
    north: row["North Direction Label"]!.trim(),
    south: row["South Direction Label"]!.trim(),
  });
}

const stations: Record<string, MtaStation> = {};
for (const stop of await readCsv(join(gtfsDir, "stops.txt"))) {
  if (stop.location_type !== "1") continue;
  const id = stop.stop_id!;
  const labels = labelsByStation.get(id);
  stations[id] = {
    name: stop.stop_name!,
    lat: Number(stop.stop_lat),
    lon: Number(stop.stop_lon),
    routes: [...(routesByStation.get(id) ?? [])].sort(),
    north: labels?.north ?? "",
    south: labels?.south ?? "",
  };
}

const out = join(import.meta.dir, "../src/builtins/data/mta-stops.json");
await Bun.write(out, `${JSON.stringify(stations)}\n`);
console.log(`wrote ${Object.keys(stations).length} stations to ${out}`);
