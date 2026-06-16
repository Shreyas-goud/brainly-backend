import dotenv from "dotenv";

dotenv.config();

/**
 * Fail-fast configuration loader.
 *
 * The app previously booted with empty/placeholder env values and only failed
 * later (Mongo connection error, forgeable JWTs signed with a hardcoded
 * fallback secret). We validate everything up-front and exit with a clear,
 * actionable message instead.
 */

function fail(message: string): never {
  console.error(`\n[config] ${message}\n`);
  process.exit(1);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(
      `Missing required environment variable: ${name}\n` +
        `Set it in brainly-backend/.env before starting the server. ` +
        `See .env.example for the expected shape.`
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export const MONGODB_URI = required("MONGODB_URI");

const jwtSecret = required("JWT_SECRET");
if (jwtSecret.length < 32) {
  fail(
    "JWT_SECRET must be at least 32 characters. Generate one with:\n" +
      "  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\""
  );
}
export const JWT_SECRET = jwtSecret;

const rawPort = optional("PORT");
const parsedPort = rawPort ? Number(rawPort) : 3001;
if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
  fail(`PORT must be a valid port number (got "${rawPort}").`);
}
export const PORT = parsedPort;

/** Optional — only required for the YouTube playlist import feature. */
export const YOUTUBE_API_KEY = optional("YOUTUBE_API_KEY");

/** Optional — GitHub personal access token to raise API rate limit to 5000/hour. */
export const GITHUB_TOKEN = optional("GITHUB_TOKEN");

/**
 * Optional — Instagram oEmbed via Facebook Graph API.
 * Get both from developers.facebook.com → your app → Settings.
 * App ID: Settings → Basic. Client Token: Settings → Advanced.
 * Access token format used internally: `${INSTAGRAM_APP_ID}|${INSTAGRAM_CLIENT_TOKEN}`
 */
export const INSTAGRAM_APP_ID = optional("INSTAGRAM_APP_ID");
export const INSTAGRAM_CLIENT_TOKEN = optional("INSTAGRAM_CLIENT_TOKEN");

/** Comma-separated list of allowed browser origins for CORS. */
export const CORS_ORIGINS = (
  optional("CORS_ORIGINS") ??
  "http://localhost:5173,http://127.0.0.1:5173"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const NODE_ENV = optional("NODE_ENV") ?? "development";
