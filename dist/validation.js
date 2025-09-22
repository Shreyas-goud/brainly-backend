"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contentSchema = exports.signinSchema = exports.signupSchema = void 0;
const zod_1 = require("zod");
exports.signupSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6, "Password should be at least 6 characters long"),
});
exports.signinSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string(),
});
exports.contentSchema = zod_1.z.object({
    title: zod_1.z.string().min(1),
    link: zod_1.z.string().url(),
    type: zod_1.z.enum(["youtube", "twitter"]),
});
