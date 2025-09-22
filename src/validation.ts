import { z } from "zod";

export const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6, "Password should be at least 6 characters long"),
});

export const signinSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const contentSchema = z.object({
  title: z.string().min(1),
  link: z.string().url(),
  type: z.enum(["youtube", "twitter"]),
});
