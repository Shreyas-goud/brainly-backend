"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.NODE_ENV = exports.CORS_ORIGINS = exports.INSTAGRAM_CLIENT_TOKEN = exports.INSTAGRAM_APP_ID = exports.GITHUB_TOKEN = exports.YOUTUBE_API_KEY = exports.PORT = exports.JWT_SECRET = exports.MONGODB_URI = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
/**
 * Fail-fast configuration loader.
 *
 * The app previously booted with empty/placeholder env values and only failed
 * later (Mongo connection error, forgeable JWTs signed with a hardcoded
 * fallback secret). We validate everything up-front and exit with a clear,
 * actionable message instead.
 */
function fail(message) {
    console.error(`\n[config] ${message}\n`);
    process.exit(1);
}
function required(name) {
    var _a;
    const value = (_a = process.env[name]) === null || _a === void 0 ? void 0 : _a.trim();
    if (!value) {
        fail(`Missing required environment variable: ${name}\n` +
            `Set it in brainly-backend/.env before starting the server. ` +
            `See .env.example for the expected shape.`);
    }
    return value;
}
function optional(name) {
    var _a;
    const value = (_a = process.env[name]) === null || _a === void 0 ? void 0 : _a.trim();
    return value || undefined;
}
exports.MONGODB_URI = required("MONGODB_URI");
const jwtSecret = required("JWT_SECRET");
if (jwtSecret.length < 32) {
    fail("JWT_SECRET must be at least 32 characters. Generate one with:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"");
}
exports.JWT_SECRET = jwtSecret;
const rawPort = optional("PORT");
const parsedPort = rawPort ? Number(rawPort) : 3001;
if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    fail(`PORT must be a valid port number (got "${rawPort}").`);
}
exports.PORT = parsedPort;
/** Optional — only required for the YouTube playlist import feature. */
exports.YOUTUBE_API_KEY = optional("YOUTUBE_API_KEY");
/** Optional — GitHub personal access token to raise API rate limit to 5000/hour. */
exports.GITHUB_TOKEN = optional("GITHUB_TOKEN");
/**
 * Optional — Instagram oEmbed via Facebook Graph API.
 * Get both from developers.facebook.com → your app → Settings.
 * App ID: Settings → Basic. Client Token: Settings → Advanced.
 * Access token format used internally: `${INSTAGRAM_APP_ID}|${INSTAGRAM_CLIENT_TOKEN}`
 */
exports.INSTAGRAM_APP_ID = optional("INSTAGRAM_APP_ID");
exports.INSTAGRAM_CLIENT_TOKEN = optional("INSTAGRAM_CLIENT_TOKEN");
/** Comma-separated list of allowed browser origins for CORS. */
exports.CORS_ORIGINS = ((_a = optional("CORS_ORIGINS")) !== null && _a !== void 0 ? _a : "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
exports.NODE_ENV = (_b = optional("NODE_ENV")) !== null && _b !== void 0 ? _b : "development";
