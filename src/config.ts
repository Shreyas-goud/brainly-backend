import dotenv from "dotenv";

dotenv.config();

export const MONGODB_URI = process.env.MONGODB_URI as string;
export const JWT_SECRET = process.env.JWT_SECRET || "default_jwt_secret";
export const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
