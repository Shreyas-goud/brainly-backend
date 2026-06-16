"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.securityHeaders = securityHeaders;
exports.createRateLimiter = createRateLimiter;
/**
 * Minimal, dependency-free security hardening. Equivalent to the subset of
 * helmet we actually need for a JSON API, plus a fixed-window rate limiter.
 * Kept dependency-free so the app builds and runs without a network install.
 */
function securityHeaders(_req, res, next) {
    // This is a JSON API, never a document host — lock framing/sniffing down.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    res.removeHeader("X-Powered-By");
    next();
}
/**
 * Fixed-window, in-memory rate limiter keyed by client IP. Adequate for a
 * single-process deployment; swap for a Redis-backed limiter when scaling
 * horizontally.
 */
function createRateLimiter(options) {
    const { windowMs, max, message = "Too many requests. Please slow down." } = options;
    const buckets = new Map();
    // Periodic sweep so the map doesn't grow unbounded.
    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [key, bucket] of buckets) {
            if (bucket.resetAt <= now)
                buckets.delete(key);
        }
    }, windowMs);
    // Don't keep the event loop alive for the sweep alone.
    if (typeof sweep.unref === "function")
        sweep.unref();
    return (req, res, next) => {
        const key = req.ip || req.socket.remoteAddress || "unknown";
        const now = Date.now();
        let bucket = buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }
        bucket.count++;
        const remaining = Math.max(0, max - bucket.count);
        res.setHeader("RateLimit-Limit", String(max));
        res.setHeader("RateLimit-Remaining", String(remaining));
        res.setHeader("RateLimit-Reset", String(Math.ceil((bucket.resetAt - now) / 1000)));
        if (bucket.count > max) {
            res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
            return res.status(429).json({ message });
        }
        next();
    };
}
