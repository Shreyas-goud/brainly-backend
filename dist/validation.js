"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contentQuerySchema = exports.shareSchema = exports.brainUpdateSchema = exports.brainCreateSchema = exports.playlistSchema = exports.contentSchema = exports.signinSchema = exports.signupSchema = void 0;
const zod_1 = require("zod");
/** Accept only real http(s) URLs — never javascript:, data:, etc. */
const httpUrl = zod_1.z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine((value) => {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    }
    catch (_a) {
        return false;
    }
}, "Must be a valid http(s) URL");
const tagList = zod_1.z
    .array(zod_1.z.string().trim().min(1).max(50))
    .max(30)
    .optional();
exports.signupSchema = zod_1.z.object({
    email: zod_1.z.string().trim().toLowerCase().email().max(254),
    // Aligned with the frontend policy (was 6 here, 8 on the client).
    password: zod_1.z
        .string()
        .min(8, "Password should be at least 8 characters long")
        .max(128),
});
exports.signinSchema = zod_1.z.object({
    email: zod_1.z.string().trim().toLowerCase().email().max(254),
    password: zod_1.z.string().min(1).max(128),
});
exports.contentSchema = zod_1.z.object({
    title: zod_1.z.string().trim().min(1).max(300),
    link: httpUrl,
    sourceType: zod_1.z.enum([
        "youtube",
        "instagram",
        "x",
        "reddit",
        "github",
        "email",
        "chat",
        "other",
    ]),
    tags: tagList,
});
exports.playlistSchema = zod_1.z.object({
    playlistUrl: httpUrl,
    // Optional custom name; falls back to the playlist's own title.
    title: zod_1.z.string().trim().min(1).max(300).optional(),
    tags: tagList,
});
const sourceTypeEnum = zod_1.z.enum([
    "youtube",
    "instagram",
    "x",
    "reddit",
    "github",
    "email",
    "chat",
    "other",
]);
exports.brainCreateSchema = zod_1.z.object({
    channel: sourceTypeEnum,
    name: zod_1.z.string().trim().max(80).optional(),
    description: zod_1.z.string().trim().max(500).optional(),
});
exports.brainUpdateSchema = zod_1.z.object({
    name: zod_1.z.string().trim().max(80).optional(),
    description: zod_1.z.string().trim().max(500).optional(),
});
exports.shareSchema = zod_1.z.object({
    channels: zod_1.z.array(sourceTypeEnum).min(1, "Select at least one channel").max(20),
});
exports.contentQuerySchema = zod_1.z.object({
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(30),
    // Keyset pagination cursor: the _id of the last item from the previous page.
    cursor: zod_1.z
        .string()
        .regex(/^[a-f\d]{24}$/i, "Invalid cursor")
        .optional(),
});
