import http from "http";
import https from "https";
import dns from "dns";
import net from "net";
import type { LookupFunction } from "net";

/**
 * SSRF protection for every server-side fetch of a user-supplied URL.
 *
 * The danger: endpoints like /link-preview and /reddit fetch arbitrary URLs.
 * Unguarded, a caller can point them at internal targets
 * (http://169.254.169.254/ cloud metadata, http://127.0.0.1, 10.x, etc.) to
 * read secrets or pivot inside the VPC. The reddit regex in particular matches
 * `reddit.com/...` anywhere in the string, so `http://169.254.169.254/reddit.com/r/x/comments/y`
 * would have sailed straight through.
 *
 * The fix: a custom DNS `lookup` wired into the HTTP(S) agents. It resolves the
 * hostname, rejects if ANY resolved address is private/loopback/link-local/
 * reserved, and only then connects. Because the check runs at *connection*
 * time (not URL-parse time) it also covers:
 *   - redirects  — each hop opens a new connection through the same agent, and
 *   - DNS rebinding — the address actually dialed is the one we validated.
 */

function ipv4ToParts(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function isBlockedIPv4(ip: string): boolean {
  const p = ipv4ToParts(ip);
  if (!p) return true; // unparseable → refuse
  const [a, b] = p;
  if (a === 0) return true; //              0.0.0.0/8     "this network"
  if (a === 10) return true; //             10.0.0.0/8    private
  if (a === 127) return true; //            127.0.0.0/8   loopback
  if (a === 169 && b === 254) return true; // 169.254/16  link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12  private
  if (a === 192 && b === 168) return true; // 192.168/16  private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10  CGNAT
  if (a >= 224) return true; //             224.0.0.0/3   multicast + reserved
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  // IPv4-mapped (::ffff:127.0.0.1) — validate the embedded v4 address.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  if (addr.startsWith("fe80")) return true; // link-local
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // unique-local fc00::/7
  if (addr.startsWith("ff")) return true; // multicast
  return false;
}

/** True if `ip` is an address we must never connect to from a server fetch. */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true; // not a parseable IP literal → refuse
}

const guardedLookup: LookupFunction = (hostname, _options, callback) => {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    if (!addresses.length) {
      return callback(new Error(`No address for ${hostname}`), "", 0);
    }
    for (const { address } of addresses) {
      if (isBlockedAddress(address)) {
        return callback(
          new Error(`Blocked request to private address (${address})`),
          "",
          0
        );
      }
    }
    const first = addresses[0];
    callback(null, first.address, first.family);
  });
};

/** Drop-in axios agents that refuse to connect to internal addresses. */
export const safeHttpAgent = new http.Agent({ lookup: guardedLookup });
export const safeHttpsAgent = new https.Agent({ lookup: guardedLookup });

/** Spread into any axios call that fetches a user-supplied URL. */
export const safeAgents = {
  httpAgent: safeHttpAgent,
  httpsAgent: safeHttpsAgent,
};

/** Reject anything that isn't a plain http(s) URL before we even dial out. */
export function assertHttpUrl(raw: string): URL {
  const url = new URL(raw); // throws on garbage
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed");
  }
  return url;
}
