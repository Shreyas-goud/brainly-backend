import { z } from "zod";

/** Accept only real http(s) URLs — never javascript:, data:, etc. */
const httpUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "Must be a valid http(s) URL");

const tagList = z
  .array(z.string().trim().min(1).max(50))
  .max(30)
  .optional();

export const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  // Aligned with the frontend policy (was 6 here, 8 on the client).
  password: z
    .string()
    .min(8, "Password should be at least 8 characters long")
    .max(128),
});

export const signinSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});

export const contentSchema = z.object({
  title: z.string().trim().min(1).max(300),
  link: httpUrl,
  sourceType: z.enum([
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

export const playlistSchema = z.object({
  playlistUrl: httpUrl,
  // Optional custom name; falls back to the playlist's own title.
  title: z.string().trim().min(1).max(300).optional(),
  tags: tagList,
});

const sourceTypeEnum = z.enum([
  "youtube",
  "instagram",
  "x",
  "reddit",
  "github",
  "email",
  "chat",
  "other",
]);

export const brainCreateSchema = z.object({
  channel: sourceTypeEnum,
  name: z.string().trim().max(80).optional(),
  description: z.string().trim().max(500).optional(),
});

export const brainUpdateSchema = z.object({
  name: z.string().trim().max(80).optional(),
  description: z.string().trim().max(500).optional(),
});

export const shareSchema = z.object({
  channels: z.array(sourceTypeEnum).min(1, "Select at least one channel").max(20),
});

export const contentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  // Keyset pagination cursor: the _id of the last item from the previous page.
  cursor: z
    .string()
    .regex(/^[a-f\d]{24}$/i, "Invalid cursor")
    .optional(),
});
