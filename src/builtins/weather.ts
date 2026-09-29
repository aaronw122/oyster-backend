import { z } from "zod";
import type { Builtin, BuiltinContext } from "../sources/builtins.ts";
import { SourceError } from "../sources/types.ts";

// Open-Meteo forecast API: keyless, global. Docs: https://open-meteo.com/en/docs
const ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const CACHE_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 8_000;
const HOURS = 12;
const DAYS = 7;

const CURRENT_VARS = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "precipitation",
  "weather_code",
  "wind_speed_10m",
  "is_day",
] as const;
const HOURLY_VARS = ["temperature_2m", "precipitation_probability", "weather_code", "is_day"] as const;
const DAILY_VARS = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_probability_max",
  "sunrise",
  "sunset",
] as const;

const UNIT_SYSTEMS = {
  fahrenheit: { temperature: "°F", windSpeed: "mph", precipitation: "in", query: { wind: "mph", precip: "inch" } },
  celsius: { temperature: "°C", windSpeed: "km/h", precipitation: "mm", query: { wind: "kmh", precip: "mm" } },
} as const;

// WMO weather interpretation codes → short plain-language conditions that fit
// widget budgets. Codes 0/1 read differently by day and night.
const CONDITIONS: Record<number, string> = {
  0: "Sunny",
  1: "Mostly sunny",
  2: "Partly cloudy",
  3: "Cloudy",
  45: "Fog",
  48: "Freezing fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  56: "Freezing drizzle",
  57: "Freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light showers",
  81: "Showers",
  82: "Heavy showers",
  85: "Snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Storm with hail",
  97: "Severe storm",
  99: "Storm with hail",
};
const NIGHT_CONDITIONS: Record<number, string> = { 0: "Clear", 1: "Mostly clear" };

/** Plain-language condition for a WMO weather code; `isDay: false` turns "Sunny" into "Clear". */
export function describeWeatherCode(code: number | null, isDay = true): string {
  if (code === null) return "Unknown";
  return (!isDay ? NIGHT_CONDITIONS[code] : undefined) ?? CONDITIONS[code] ?? "Unknown";
}

function numberInRange(name: string, min: number, max: number) {
  return z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d+)?$/, `${name} must be a number`)
    .refine((value) => {
      const n = Number(value);
      return n >= min && n <= max;
    }, `${name} must be between ${min} and ${max}`);
}

function isTimeZone(value: string): boolean {
  if (value === "auto") return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const WeatherParams = z
  .object({
    lat: numberInRange("lat", -90, 90),
    lon: numberInRange("lon", -180, 180),
    units: z.enum(["fahrenheit", "celsius"]).default("fahrenheit"),
    timezone: z
      .string()
      .trim()
      .default("auto")
      .refine(isTimeZone, "timezone must be an IANA time zone like America/New_York, or auto"),
  })
  .strict();

const num = z.number().nullable();
const OpenMeteoResponse = z.object({
  timezone: z.string(),
  current: z.object({
    time: z.string(),
    temperature_2m: num,
    apparent_temperature: num,
    relative_humidity_2m: num,
    precipitation: num,
    weather_code: num,
    wind_speed_10m: num,
    is_day: num,
  }),
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: z.array(num),
    precipitation_probability: z.array(num),
    weather_code: z.array(num),
    is_day: z.array(num),
  }),
  daily: z.object({
    time: z.array(z.string()),
    weather_code: z.array(num),
    temperature_2m_max: z.array(num),
    temperature_2m_min: z.array(num),
    precipitation_probability_max: z.array(num),
    sunrise: z.array(z.string().nullable()),
    sunset: z.array(z.string().nullable()),
  }),
});
type OpenMeteoResponse = z.infer<typeof OpenMeteoResponse>;

export type WeatherData = {
  units: { temperature: string; windSpeed: string; precipitation: string };
  current: {
    time: string;
    temperature: number | null;
    apparentTemperature: number | null;
    humidity: number | null;
    precipitation: number | null;
    weatherCode: number | null;
    condition: string;
    windSpeed: number | null;
    isDay: boolean;
  };
  hourly: Array<{
    time: string;
    temperature: number | null;
    precipitationProbability: number | null;
    weatherCode: number | null;
    condition: string;
  }>;
  daily: Array<{
    date: string;
    high: number | null;
    low: number | null;
    precipitationProbability: number | null;
    weatherCode: number | null;
    condition: string;
    sunrise: string | null;
    sunset: string | null;
  }>;
  timezone: string;
};

type Units = keyof typeof UNIT_SYSTEMS;

export function weatherUrl(params: { lat: string; lon: string; units: Units; timezone: string }): string {
  const system = UNIT_SYSTEMS[params.units];
  const query = new URLSearchParams({
    latitude: params.lat,
    longitude: params.lon,
    current: CURRENT_VARS.join(","),
    hourly: HOURLY_VARS.join(","),
    daily: DAILY_VARS.join(","),
    temperature_unit: params.units,
    wind_speed_unit: system.query.wind,
    precipitation_unit: system.query.precip,
    timezone: params.timezone,
    forecast_days: String(DAYS),
    // Hourly data starts at the current (partial) hour; one extra covers 12 full hours ahead.
    forecast_hours: String(HOURS + 1),
  });
  return `${ENDPOINT}?${query}`;
}

/** Converts a raw Open-Meteo forecast response into the normalized weather shape. */
export function normalizeWeather(raw: unknown, units: Units): WeatherData {
  const parsed = OpenMeteoResponse.safeParse(raw);
  if (!parsed.success) throw new SourceError("parse", "the weather service returned data in an unexpected format");
  const data: OpenMeteoResponse = parsed.data;
  const { current, hourly, daily } = data;
  const system = UNIT_SYSTEMS[units];

  // Timestamps are local wall-clock strings in one format ("YYYY-MM-DDTHH:MM"),
  // so lexical order is chronological.
  const hours: WeatherData["hourly"] = [];
  for (const [i, time] of hourly.time.entries()) {
    if (time <= current.time) continue;
    if (hours.length === HOURS) break;
    const code = hourly.weather_code[i] ?? null;
    hours.push({
      time,
      temperature: hourly.temperature_2m[i] ?? null,
      precipitationProbability: hourly.precipitation_probability[i] ?? null,
      weatherCode: code,
      condition: describeWeatherCode(code, hourly.is_day[i] !== 0),
    });
  }

  const days: WeatherData["daily"] = daily.time.slice(0, DAYS).map((date, i) => {
    const code = daily.weather_code[i] ?? null;
    return {
      date,
      high: daily.temperature_2m_max[i] ?? null,
      low: daily.temperature_2m_min[i] ?? null,
      precipitationProbability: daily.precipitation_probability_max[i] ?? null,
      weatherCode: code,
      condition: describeWeatherCode(code),
      sunrise: daily.sunrise[i] ?? null,
      sunset: daily.sunset[i] ?? null,
    };
  });

  const isDay = current.is_day !== 0;
  return {
    units: { temperature: system.temperature, windSpeed: system.windSpeed, precipitation: system.precipitation },
    current: {
      time: current.time,
      temperature: current.temperature_2m,
      apparentTemperature: current.apparent_temperature,
      humidity: current.relative_humidity_2m,
      precipitation: current.precipitation,
      weatherCode: current.weather_code,
      condition: describeWeatherCode(current.weather_code, isDay),
      windSpeed: current.wind_speed_10m,
      isDay,
    },
    hourly: hours,
    daily: days,
    timezone: data.timezone,
  };
}

async function fetchWeather(rawParams: Record<string, string>, ctx: BuiltinContext): Promise<WeatherData> {
  const parsedParams = WeatherParams.safeParse(rawParams);
  if (!parsedParams.success) {
    throw new SourceError("invalid_params", parsedParams.error.issues.map((issue) => issue.message).join("; "));
  }
  const params = parsedParams.data;
  const url = weatherUrl(params);

  let response: Response;
  try {
    response = await ctx.fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "could not be reached";
    throw new SourceError("network", `the weather service ${reason}`);
  }
  if (!response.ok) {
    // Open-Meteo explains 4xx failures as `{ "error": true, "reason": "..." }`.
    const body: unknown = await response.json().catch(() => null);
    const reason =
      body !== null && typeof body === "object" && "reason" in body && typeof body.reason === "string"
        ? `: ${body.reason}`
        : "";
    throw new SourceError("http", `the weather service returned HTTP ${response.status}${reason}`);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new SourceError("parse", "the weather service did not return valid JSON");
  }
  return normalizeWeather(raw, params.units);
}

export const weather: Builtin = {
  name: "weather",
  description: [
    "Current conditions plus a 12-hour and 7-day forecast for any location, from Open-Meteo (no account needed).",
    "Params: lat (-90..90), lon (-180..180), units (fahrenheit | celsius; default fahrenheit; also picks mph/in vs km/h/mm),",
    "timezone (IANA name like America/New_York; default auto = the location's local time).",
    "Returns { units: { temperature, windSpeed, precipitation },",
    "current: { time, temperature, apparentTemperature, humidity, precipitation, weatherCode, condition, windSpeed, isDay },",
    "hourly: [{ time, temperature, precipitationProbability, weatherCode, condition }] (next 12 hours),",
    "daily: [{ date, high, low, precipitationProbability, weatherCode, condition, sunrise, sunset }] (7 days, today first),",
    "timezone }.",
    "Times are local wall-clock strings like 2026-09-29T16:00 (dates like 2026-09-29); numbers may be null when unavailable;",
    "condition is short plain text like Sunny, Partly cloudy, Light rain; humidity and precipitationProbability are percents.",
  ].join(" "),
  params: WeatherParams,
  ttlMs: CACHE_TTL_MS,
  fetch: fetchWeather,
};
