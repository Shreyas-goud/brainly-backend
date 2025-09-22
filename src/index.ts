import express from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { UserModel, ContentModel, LinkModel } from "./db";
import { JWT_SECRET, MONGODB_URI, PORT } from "./config";
import { userMiddleware } from "./middleware";
import { random } from "./utils";
import cors from "cors";
import { signupSchema, signinSchema, contentSchema } from "./validation";

const app = express();

function isZodError(error: unknown): error is { name: string; errors: any } {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as any).name === "ZodError"
  );
}

mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("MongoDB connected");
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

app.use(express.json());
app.use(cors());

app.post("/api/v1/signup", async (req, res) => {
  try {
    const parsed = signupSchema.parse(req.body);
    const existingUser = await UserModel.findOne({ email: parsed.email });
    if (existingUser) {
      return res.status(409).json({ message: "User already exists" });
    }
    const hashedPassword = await bcrypt.hash(parsed.password, 10);
    await UserModel.create({
      email: parsed.email,
      password: hashedPassword,
    });
    res.status(201).json({ message: "User signed up successfully" });
  } catch (err) {
    if (isZodError(err)) {
      return res.status(400).json({ errors: err.errors });
    }
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.post("/api/v1/signin", async (req, res) => {
  try {
    const parsed = signinSchema.parse(req.body);
    const user = await UserModel.findOne({ email: parsed.email });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    const isPasswordValid = await bcrypt.compare(
      parsed.password,
      user.password
    );
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token });
  } catch (err) {
    if (isZodError(err)) {
      return res.status(400).json({ errors: err.errors });
    }
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.post("/api/v1/content", userMiddleware, async (req, res) => {
  try {
    const parsed = contentSchema.parse(req.body);
    await ContentModel.create({
      ...parsed,
      userId: req.userId,
      tags: [],
    });
    res.status(201).json({ message: "Content added" });
  } catch (err) {
    if (isZodError(err)) {
      return res.status(400).json({ errors: err.errors });
    }
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.get("/api/v1/content", userMiddleware, async (req, res) => {
  try {
    const content = await ContentModel.find({
      userId: req.userId,
    }).populate("userId", "email");
    res.json({ content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.delete("/api/v1/content", userMiddleware, async (req, res) => {
  try {
    const contentId = req.body.contentId;
    if (!contentId) {
      return res.status(400).json({ message: "contentId is required" });
    }
    await ContentModel.deleteOne({
      _id: contentId,
      userId: req.userId,
    });
    res.json({ message: "Content deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.post("/api/v1/brain/share", userMiddleware, async (req, res) => {
  try {
    const share = req.body.share;
    if (share) {
      const existingLink = await LinkModel.findOne({ userId: req.userId });
      if (existingLink) {
        return res.json({ hash: existingLink.hash });
      }
      const hash = random(10);
      await LinkModel.create({ userId: req.userId, hash });
      return res.json({ hash });
    } else {
      await LinkModel.deleteOne({ userId: req.userId });
      return res.json({ message: "Removed link" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.get("/api/v1/brain/:shareLink", async (req, res) => {
  try {
    const hash = req.params.shareLink;
    const link = await LinkModel.findOne({ hash });
    if (!link) {
      return res.status(404).json({ message: "Invalid share link" });
    }
    const content = await ContentModel.find({ userId: link.userId });
    const user = await UserModel.findById(link.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json({ email: user.email, content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
