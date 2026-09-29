import { expect, test } from "bun:test";
import { lintUserFacingText } from "./lint.ts";
import { parseDuckDuckGoHtml } from "./search.ts";

test("flags URLs, JSON, code fences, endpoint paths, code, and stack traces", () => {
  const cases: Array<[string, string]> = [
    ["Data comes from https://gbfs.citibikenyc.com/gbfs/2.3/gbfs.json.", "URL"],
    ["Check www.example.com for details.", "URL"],
    ["I used api.citybik.es/v2/networks for this.", "URL"],
    ['The feed returns {"station_id": "72"} for each station.', "JSON"],
    ["```js\n(s) => s\n```", "code fence"],
    ["It reads /v2/stations every minute.", "endpoint path"],
    ["The value is computed with (s) => s.w.temp.", "code"],
    ["Try `std.nearest` on the list.", "code"],
    ["It failed with TypeError: cannot read property of undefined.", "stack trace"],
    ["    at fetchSources (/app/src/sources/fetch.ts:41:12)", "stack trace"],
    ["The URL uses {inputs.lat} for latitude.", "template placeholder"],
  ];
  for (const [text, violation] of cases) expect(lintUserFacingText(text)).toContain(violation);
});

test("plain prose passes", () => {
  const prose = [
    "Which office should I use?",
    "The nearest station with 3+ docks is W 21 St & 6 Av, 0.2 mi away.",
    "Your L train at Bedford Av (toward 8 Av) comes every 4–6 minutes, 24/7.",
    "Citi Bike, Open-Meteo, and the MTA are all free to use.",
    "I can't use that service yet because it needs an API key.",
    "It's 72° and sunny; the high is 78°. Want it in Celsius instead?",
    "Saved as \"Office Citi Bike\". Add it from the widget gallery and/or the lock screen.",
    "Balance: $1,234.56 as of 5:30 pm.",
  ];
  for (const text of prose) expect({ text, violations: lintUserFacingText(text) }).toEqual({ text, violations: [] });
});

test("DuckDuckGo HTML results unwrap redirect links and skip ads", () => {
  const html = `
    <div class="result results_links results_links_deep result--ad">
      <a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example">Ad</a>
    </div>
    <div class="result results_links results_links_deep web-result ">
      <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fopen%2Dmeteo.com%2Fen%2Fdocs&amp;rut=abc">Weather <b>API</b> &amp; docs</a></h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Free weather API, no key &#x27;required&#x27;.</a>
    </div>`;
  expect(parseDuckDuckGoHtml(html)).toEqual([
    { title: "Weather API & docs", url: "https://open-meteo.com/en/docs", snippet: "Free weather API, no key 'required'." },
  ]);
});
