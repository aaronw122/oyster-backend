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

  // Half away from zero, using exponent shifting to avoid 1.005 -> 1.00 drift.
  function round(n, digits) {
    var d = digits === undefined ? 0 : Math.trunc(digits);
    if (!Number.isFinite(n)) return n;
    var sign = n < 0 ? -1 : 1;
    var shifted = Math.round(Number(Math.abs(n) + "e" + d));
    var result = sign * Number(shifted + "e" + -d);
    return result === 0 ? 0 : result;
  }

  function formatNumber(n, opts) {
    if (!Number.isFinite(n)) return String(n);
    var decimals = opts && opts.decimals !== undefined ? Math.max(0, Math.trunc(opts.decimals)) : undefined;
    var abs = Math.abs(decimals === undefined ? n : round(n, decimals));
    // Beyond 1e21 String/toFixed switch to exponent notation; print digits instead.
    var text =
      abs >= 1e21 ? BigInt(Math.round(abs)).toString() : decimals === undefined ? String(abs) : abs.toFixed(decimals);
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
      if (!c) continue;
      var lat = Number(c.lat);
      var lon = Number(c.lon);
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
