// `std` helper library for transforms. This is JS *source* evaluated inside the
// QuickJS VM (never on the host), so it must stay pure ES2020 with no I/O.
// QuickJS has no `Intl`, so number formatting is done by hand.
export const STD_SOURCE = String.raw`(function () {
  "use strict";
  var EARTH_RADIUS_MILES = 3958.7613;
  var CURRENCY_SYMBOLS = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", INR: "₹", KRW: "₩", CNY: "¥", CAD: "CA$", AUD: "A$" };

  function toRadians(degrees) {
    return (degrees * Math.PI) / 180;
  }

  function distance(latA, lonA, latB, lonB) {
    var dLat = toRadians(latB - latA);
    var dLon = toRadians(lonB - lonA);
    var s =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRadians(latA)) * Math.cos(toRadians(latB)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  // x * 10^e computed by editing the decimal exponent (no binary drift), and
  // valid even when String(x) is already in exponent form ("1e-7", "1e+21").
  function shiftDecimal(x, e) {
    var parts = String(x).split("e");
    return Number(parts[0] + "e" + (Number(parts[1] || 0) + e));
  }

  // Half away from zero, so 1.005 -> 1.01 and -2.5 -> -3.
  function round(n, digits) {
    var d = digits === undefined ? 0 : Math.trunc(digits);
    if (!Number.isFinite(n)) return n;
    var shifted = shiftDecimal(Math.abs(n), d);
    // Beyond double precision there is no fractional part left to round.
    if (!Number.isFinite(shifted) || shifted >= 9007199254740992) return n;
    var result = (n < 0 ? -1 : 1) * shiftDecimal(Math.round(shifted), -d);
    return result === 0 ? 0 : result;
  }

  function formatNumber(n, opts) {
    if (!Number.isFinite(n)) return String(n);
    var decimals = opts && opts.decimals !== undefined ? Math.max(0, Math.trunc(opts.decimals)) : undefined;
    var abs = Math.abs(decimals === undefined ? n : round(n, decimals));
    // String/toFixed use exponent notation beyond 1e21 and String below 1e-6; print plain digits instead.
    var text =
      abs >= 1e21
        ? BigInt(Math.round(abs)).toString() + (decimals ? "." + "0".repeat(decimals) : "")
        : decimals !== undefined
          ? abs.toFixed(decimals)
          : String(abs).indexOf("e") !== -1
            ? abs.toFixed(20).replace(/\.?0+$/, "")
            : String(abs);
    var dot = text.indexOf(".");
    var intPart = dot === -1 ? text : text.slice(0, dot);
    var fracPart = dot === -1 ? "" : text.slice(dot);
    var body = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + fracPart;
    return n < 0 && /[1-9]/.test(text) ? "-" + body : body;
  }

  function formatMoney(n, currency) {
    var code = (currency === undefined ? "USD" : String(currency)).toUpperCase();
    var amount = formatNumber(Math.abs(n), { decimals: 2 });
    var negative = n < 0 && amount !== "0.00";
    var symbol = CURRENCY_SYMBOLS[code];
    var body = symbol !== undefined ? symbol + amount : code + " " + amount;
    return negative ? "-" + body : body;
  }

  // Counts Unicode code points; the ellipsis counts toward n.
  function truncate(str, n) {
    var s = String(str);
    var chars = Array.from(s);
    var max = Math.max(0, Math.trunc(n));
    if (chars.length <= max) return s;
    if (max === 0) return "";
    return chars.slice(0, max - 1).join("").trimEnd() + "…";
  }

  // Finite numbers or non-empty numeric strings; anything else (null, "", objects) is NaN.
  function coordinate(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") return Number(v);
    return NaN;
  }

  function coordsOf(item, key) {
    if (typeof key === "function") return key(item);
    if (item === null || typeof item !== "object") return null;
    var latField = key && key.lat !== undefined ? key.lat : "lat";
    var lonField = key && key.lon !== undefined ? key.lon : "lon";
    return { lat: item[latField], lon: item[lonField] };
  }

  // key: omitted (item.lat/item.lon), { lat: "field", lon: "field" }, or item => ({ lat, lon }).
  function nearest(list, point, key) {
    var best = null;
    var bestDistance = Infinity;
    for (var i = 0; i < list.length; i++) {
      var c = coordsOf(list[i], key);
      if (c === null || typeof c !== "object") continue;
      var lat = coordinate(c.lat);
      var lon = coordinate(c.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      var d = distance(point.lat, point.lon, lat, lon);
      if (d < bestDistance) {
        bestDistance = d;
        best = list[i];
      }
    }
    return best;
  }

  return Object.freeze({
    distance: distance,
    formatNumber: formatNumber,
    formatMoney: formatMoney,
    truncate: truncate,
    nearest: nearest,
    round: round,
  });
})()`;
