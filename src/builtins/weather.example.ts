import type { SavePearlRequest } from "../contract/index.ts";

/** "Weather at my office": current temperature + condition, today's high/low, the next few hours. */
export const weatherExample: SavePearlRequest = {
  name: "Weather at my office",
  inputs: { lat: "40.7484", lon: "-73.9857", units: "fahrenheit" },
  sources: [
    {
      id: "weather",
      builtin: "weather",
      method: "GET",
      params: { lat: "{inputs.lat}", lon: "{inputs.lon}", units: "{inputs.units}" },
    },
  ],
  transform: String.raw`(sources, inputs, std) => {
  const w = sources.weather;
  const deg = (n) => (n === null || n === undefined ? "--" : std.round(n) + "°");
  const hourLabel = (time) => {
    const h = Number(time.slice(11, 13));
    return (h % 12 || 12) + (h < 12 ? " AM" : " PM");
  };
  const today = w.daily[0];
  const highLow = today ? "H " + deg(today.high) + " L " + deg(today.low) : "";
  const full = deg(w.current.temperature) + " " + w.current.condition;
  const value = full.length <= 12 ? full : deg(w.current.temperature);
  const withCondition = w.current.condition + ", " + highLow;
  const subtitle = value === full || withCondition.length > 24 ? highLow : withCondition;
  const items = w.hourly
    .filter((_, i) => i % 2 === 0)
    .slice(0, 5)
    .map((hour) => {
      const label = hourLabel(hour.time) + " " + hour.condition;
      const rain = hour.precipitationProbability >= 20 ? " " + hour.precipitationProbability + "%" : "";
      return {
        label: label.length <= 22 ? label : hourLabel(hour.time),
        value: deg(hour.temperature) + rain,
      };
    });
  return { value, subtitle, items };
}`,
};
