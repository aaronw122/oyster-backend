import { describe, expect, test } from "bun:test";
import { runTransform } from "../sandbox/index.ts";
import { createMemorySourceCache, fetchSources, SourceError } from "../sources/index.ts";
import nycFahrenheit from "./__fixtures__/weather/nyc-fahrenheit.json";
import parisCelsius from "./__fixtures__/weather/paris-celsius.json";
import { builtinContext, expectFitsAllSizes, json, offlineFetch, recordingFetch, renderExample } from "./testing.ts";
import { describeWeatherCode, normalizeWeather, type WeatherData, weather } from "./weather.ts";
import { weatherExample } from "./weather.example.ts";

// Recorded 2026-09-29 from api.open-meteo.com with the exact query `weatherUrl` builds.
const FIXTURES = { fahrenheit: nycFahrenheit, celsius: parisCelsius } as const;

/** Serves the recorded fixture matching the requested temperature unit. */
const fixtureFetch = () =>
  recordingFetch((url) => json(FIXTURES[url.searchParams.get("temperature_unit") as keyof typeof FIXTURES]));

const ctx = (fetchFn: typeof fetch, cache = createMemorySourceCache()) => builtinContext(fetchFn, { cache });

const params = (overrides: Record<string, string> = {}) => weather.params.parse({ lat: "40.7484", lon: "-73.9857", ...overrides });

describe("weather: normalization of recorded responses", () => {
  test("fahrenheit fixture → imperial units, current, next 12 hours, 7 days", () => {
    const data = normalizeWeather(nycFahrenheit, "fahrenheit");
    expect(data.units).toEqual({ temperature: "°F", windSpeed: "mph", precipitation: "in" });
    expect(data.timezone).toBe("America/New_York");
    expect(data.current).toEqual({
      time: "2026-09-29T15:30",
      temperature: nycFahrenheit.current.temperature_2m,
      apparentTemperature: nycFahrenheit.current.apparent_temperature,
      humidity: nycFahrenheit.current.relative_humidity_2m,
      precipitation: nycFahrenheit.current.precipitation,
      weatherCode: 3,
      condition: "Cloudy",
      windSpeed: nycFahrenheit.current.wind_speed_10m,
      isDay: true,
    });

    // Hourly starts at the first full hour after "now" (the 15:00 partial hour is dropped).
    expect(data.hourly).toHaveLength(12);
    expect(data.hourly[0]!.time).toBe("2026-09-29T16:00");
    expect(data.hourly.at(-1)!.time).toBe("2026-09-30T03:00");
    expect(data.hourly[0]).toEqual({
      time: "2026-09-29T16:00",
      temperature: nycFahrenheit.hourly.temperature_2m[1]!,
      precipitationProbability: nycFahrenheit.hourly.precipitation_probability[1]!,
      weatherCode: nycFahrenheit.hourly.weather_code[1]!,
      condition: describeWeatherCode(nycFahrenheit.hourly.weather_code[1]!, true),
    });

    expect(data.daily).toHaveLength(7);
    expect(data.daily[0]).toEqual({
      date: "2026-09-29",
      high: nycFahrenheit.daily.temperature_2m_max[0]!,
      low: nycFahrenheit.daily.temperature_2m_min[0]!,
      precipitationProbability: nycFahrenheit.daily.precipitation_probability_max[0]!,
      weatherCode: nycFahrenheit.daily.weather_code[0]!,
      condition: describeWeatherCode(nycFahrenheit.daily.weather_code[0]!),
      sunrise: "2026-09-29T06:50",
      sunset: nycFahrenheit.daily.sunset[0]!,
    });
  });

  test("celsius fixture → metric units; night hours use night conditions", () => {
    const data = normalizeWeather(parisCelsius, "celsius");
    expect(data.units).toEqual({ temperature: "°C", windSpeed: "km/h", precipitation: "mm" });
    expect(data.timezone).toBe("Europe/Paris");
    expect(data.current.temperature).toBe(parisCelsius.current.temperature_2m);
    expect(data.current.isDay).toBe(false);
    expect(data.daily.map((day) => day.high)).toEqual(parisCelsius.daily.temperature_2m_max);
    expect(data.hourly).toHaveLength(12);
    expect(data.hourly.every((hour) => hour.time > data.current.time)).toBe(true);
  });

  test("null readings stay null; the partial current hour never counts toward the 12", () => {
    const raw = structuredClone(nycFahrenheit) as typeof nycFahrenheit & Record<string, unknown>;
    (raw.current as Record<string, unknown>).temperature_2m = null;
    (raw.hourly.precipitation_probability as Array<number | null>)[1] = null;
    (raw.daily.weather_code as Array<number | null>)[0] = null;
    raw.current.time = "2026-09-29T15:00";
    const data = normalizeWeather(raw, "fahrenheit");
    expect(data.current.temperature).toBeNull();
    expect(data.hourly[0]!.time).toBe("2026-09-29T16:00");
    expect(data.hourly[0]!.precipitationProbability).toBeNull();
    expect(data.daily[0]!.condition).toBe("Unknown");
  });

  test("an unexpected payload is a parse error, not a crash", () => {
    const { daily: _daily, ...withoutDaily } = nycFahrenheit;
    for (const raw of [withoutDaily, { error: true }]) {
      let thrown: unknown;
      try {
        normalizeWeather(raw, "fahrenheit");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SourceError);
      expect(thrown).toMatchObject({ kind: "parse" });
    }
  });
});

describe("weather: WMO condition codes", () => {
  // Every code in Open-Meteo's WMO table.
  const DOCUMENTED = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 97, 99];

  test("every documented code has a short plain-language condition, day and night", () => {
    for (const code of DOCUMENTED) {
      for (const isDay of [true, false]) {
        const condition = describeWeatherCode(code, isDay);
        expect(condition).not.toBe("Unknown");
        expect([...condition].length).toBeLessThanOrEqual(18);
      }
    }
  });

  test("clear skies read differently by day and night; others do not", () => {
    expect([describeWeatherCode(0, true), describeWeatherCode(0, false)]).toEqual(["Sunny", "Clear"]);
    expect([describeWeatherCode(1, true), describeWeatherCode(1, false)]).toEqual(["Mostly sunny", "Mostly clear"]);
    expect(describeWeatherCode(63, false)).toBe("Rain");
    expect(describeWeatherCode(95)).toBe("Thunderstorm");
  });

  test("undocumented or missing codes are Unknown", () => {
    expect(describeWeatherCode(4)).toBe("Unknown");
    expect(describeWeatherCode(100)).toBe("Unknown");
    expect(describeWeatherCode(null)).toBe("Unknown");
  });
});

describe("weather: params", () => {
  test("defaults to fahrenheit and the location's own time zone", () => {
    expect(params()).toEqual({ lat: "40.7484", lon: "-73.9857", units: "fahrenheit", timezone: "auto" });
    expect(params({ units: "celsius", timezone: "Europe/Paris" })).toMatchObject({ units: "celsius", timezone: "Europe/Paris" });
    expect(params({ lat: "90", lon: "-180" })).toMatchObject({ lat: "90", lon: "-180" });
  });

  test.each([
    ["lat above 90", { lat: "90.1" }],
    ["lon below -180", { lon: "-180.5" }],
    ["non-numeric lat", { lat: "north" }],
    ["empty lon", { lon: "" }],
    ["unknown unit", { units: "kelvin" }],
    ["bad time zone", { timezone: "Mars/Olympus" }],
    ["unknown param", { latitude: "40" }],
  ])("rejects %s", (_name, overrides) => {
    expect(weather.params.safeParse({ lat: "40.7484", lon: "-73.9857", ...overrides }).success).toBe(false);
  });
});

describe("weather: fetch", () => {
  test("requests explicit variables with units matching the chosen system", async () => {
    const imperial = fixtureFetch();
    await weather.fetch(params(), ctx(imperial.fetch));
    const metric = fixtureFetch();
    await weather.fetch(params({ units: "celsius", timezone: "Europe/Paris" }), ctx(metric.fetch));

    const f = imperial.calls[0]!.url;
    expect(f.origin + f.pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(Object.fromEntries(f.searchParams)).toMatchObject({
      latitude: "40.7484",
      longitude: "-73.9857",
      temperature_unit: "fahrenheit",
      wind_speed_unit: "mph",
      precipitation_unit: "inch",
      timezone: "auto",
      forecast_days: "7",
    });
    expect(f.searchParams.get("current")!.split(",")).toContain("apparent_temperature");
    expect(f.searchParams.get("daily")!.split(",")).toContain("temperature_2m_max");
    expect(Object.fromEntries(metric.calls[0]!.url.searchParams)).toMatchObject({
      temperature_unit: "celsius",
      wind_speed_unit: "kmh",
      precipitation_unit: "mm",
      timezone: "Europe/Paris",
    });
  });

  test("fetchSources caches results for 10 minutes per location and units", async () => {
    let now = 0;
    const { fetch, calls } = fixtureFetch();
    const deps = { resolveAuth: async () => null, fetch, builtins: [weather], env: {}, cache: createMemorySourceCache(() => now) };
    const pearl = (units: string) => ({
      inputs: {},
      sources: [{ id: "w", builtin: "weather", method: "GET" as const, params: { lat: "40.7484", lon: "-73.9857", units } }],
    });
    const first = await fetchSources(pearl("fahrenheit"), deps);
    expect(first.ok).toBe(true);
    now = 10 * 60_000 - 1;
    expect(await fetchSources(pearl("fahrenheit"), deps)).toEqual(first);
    expect(calls).toHaveLength(1);
    await fetchSources(pearl("celsius"), deps);
    expect(calls).toHaveLength(2);
    now = 10 * 60_000;
    await fetchSources(pearl("fahrenheit"), deps);
    expect(calls).toHaveLength(3);
  });

  test("the builtin itself does not cache: fetchSources owns the result cache", async () => {
    const { fetch, calls } = fixtureFetch();
    const cache = createMemorySourceCache(() => 0);
    await weather.fetch(params(), ctx(fetch, cache));
    await weather.fetch(params(), ctx(fetch, cache));
    expect(calls).toHaveLength(2);
  });

  test("provider errors surface as typed failures with the provider's reason", async () => {
    const rejected = recordingFetch(() => json({ error: true, reason: "Invalid timezone" }, 400));
    await expect(weather.fetch(params(), ctx(rejected.fetch))).rejects.toMatchObject({
      kind: "http",
      message: "the weather service returned HTTP 400: Invalid timezone",
    });
    const down = recordingFetch(() => new Response("upstream", { status: 503 }));
    await expect(weather.fetch(params(), ctx(down.fetch))).rejects.toMatchObject({ kind: "http" });
    const garbage = recordingFetch(() => new Response("<html>", { status: 200 }));
    await expect(weather.fetch(params(), ctx(garbage.fetch))).rejects.toMatchObject({ kind: "parse" });
    await expect(weather.fetch(params(), ctx(offlineFetch))).rejects.toMatchObject({ kind: "network" });
  });
});

describe("weather: example Pearl", () => {
  const runExample = (fetchFn: typeof fetch, inputs: Record<string, unknown> = weatherExample.inputs) =>
    renderExample(weatherExample, { fetch: fetchFn }, inputs);

  test("renders the recorded NYC forecast and fits all four sizes", async () => {
    const output = await runExample(fixtureFetch().fetch);
    expect(output.value).toBe("68° Cloudy");
    expect(output.subtitle).toBe("H 70° L 58°");
    expect(output.items![0]).toEqual({ label: "4 PM Partly cloudy", value: "69°" });
  });

  test("fits all sizes in celsius and in worst-case long conditions and extreme values", async () => {
    await runExample(fixtureFetch().fetch, { ...weatherExample.inputs, units: "celsius" });

    const extreme = structuredClone(nycFahrenheit);
    extreme.current.weather_code = 86; // "Heavy snow showers"
    extreme.current.temperature_2m = -40.4;
    extreme.hourly.weather_code = extreme.hourly.weather_code.map(() => 86);
    extreme.hourly.temperature_2m = extreme.hourly.temperature_2m.map(() => -40.4);
    extreme.hourly.precipitation_probability = extreme.hourly.precipitation_probability.map(() => 100);
    extreme.daily.temperature_2m_max = extreme.daily.temperature_2m_max.map(() => 120.6);
    extreme.daily.temperature_2m_min = extreme.daily.temperature_2m_min.map(() => -100.2);
    const output = await runExample(recordingFetch(() => json(extreme)).fetch);
    expect(output.value).toBe("-40°");
  });
});

describe.skipIf(!process.env.LIVE)("weather: live Open-Meteo", () => {
  test("returns a normalized forecast for New York", async () => {
    const data = (await weather.fetch(params(), ctx(fetch))) as WeatherData;
    expect(data.units.temperature).toBe("°F");
    expect(data.timezone).toBe("America/New_York");
    expect(typeof data.current.temperature).toBe("number");
    expect(data.hourly).toHaveLength(12);
    expect(data.daily).toHaveLength(7);
    const output = await runTransform(weatherExample.transform, { weather: data }, weatherExample.inputs);
    if (!output.ok) throw new Error(output.error.message);
    expectFitsAllSizes(output.output);
  });
});
