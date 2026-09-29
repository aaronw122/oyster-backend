// SSRF guard for agent-authored URL sources: only http(s) to public hosts.
// Literal IPs and every DNS-resolved address must be publicly routable.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SourceError } from "./types.ts";

/** Resolves a hostname to all of its IP addresses. */
export type HostResolver = (hostname: string) => Promise<string[]>;

export const resolveHostWithDns: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * Parses `raw` and throws `SourceError("forbidden_url")` unless it is http(s)
 * and its host (literal or resolved) is a public address. DNS failures are
 * `network` errors.
 */
export async function assertPublicUrl(raw: string, resolveHost: HostResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceError("forbidden_url", `"${raw}" is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SourceError("forbidden_url", `${url.protocol} URLs are not allowed; use http or https`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new SourceError("forbidden_url", `host ${host} is not public`);
  }

  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await resolveHost(host);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SourceError("network", `could not resolve ${host}: ${message}`);
    }
    if (addresses.length === 0) throw new SourceError("network", `could not resolve ${host}`);
  }
  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      throw new SourceError("forbidden_url", `host ${host} resolves to non-public address ${address}`);
    }
  }
  return url;
}

/** False for loopback, private, link-local, unspecified, CGNAT, multicast, and reserved ranges. */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address.split(".").map(Number));
  if (version === 6) return isPublicIpv6(ipv6Groups(address));
  return false;
}

function isPublicIpv4([a, b]: number[]): boolean {
  if (a === undefined || b === undefined) return false;
  return !(
    a === 0 || // unspecified / "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

function isPublicIpv6(groups: number[]): boolean {
  const first = groups[0] ?? 0;
  const upperZero = groups.slice(0, 5).every((group) => group === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compat) embed an IPv4 address.
  if (upperZero && (groups[5] === 0xffff || groups[5] === 0)) {
    if (groups[5] === 0 && groups[6] === 0 && (groups[7] ?? 0) <= 1) return false; // :: and ::1
    return isPublicIpv4(embeddedIpv4(groups));
  }
  // 64:ff9b::/96 NAT64 embeds an IPv4 address.
  if (first === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return isPublicIpv4(embeddedIpv4(groups));
  }
  return !(
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 // multicast
  );
}

function embeddedIpv4(groups: number[]): number[] {
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/** Expands a valid IPv6 literal (optionally with a dotted IPv4 tail or zone) to 8 numeric groups. */
function ipv6Groups(address: string): number[] {
  const withoutZone = address.split("%")[0] ?? "";
  const toGroups = (part: string): number[] =>
    part === ""
      ? []
      : part.split(":").flatMap((piece) => {
          if (!piece.includes(".")) return [Number.parseInt(piece, 16)];
          const [a = 0, b = 0, c = 0, d = 0] = piece.split(".").map(Number);
          return [(a << 8) | b, (c << 8) | d];
        });
  const [head = "", tail] = withoutZone.split("::");
  const headGroups = toGroups(head);
  if (tail === undefined) return headGroups;
  const tailGroups = toGroups(tail);
  return [...headGroups, ...Array<number>(8 - headGroups.length - tailGroups.length).fill(0), ...tailGroups];
}
