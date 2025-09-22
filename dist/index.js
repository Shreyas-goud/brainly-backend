"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const mongoose_1 = __importDefault(require("mongoose"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const db_1 = require("./db");
const config_1 = require("./config");
const middleware_1 = require("./middleware");
const utils_1 = require("./utils");
const cors_1 = __importDefault(require("cors"));
const validation_1 = require("./validation");
const app = (0, express_1.default)();
function isZodError(error) {
    return (typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "ZodError");
}
console.log(typeof config_1.MONGODB_URI);
mongoose_1.default
    .connect(config_1.MONGODB_URI, {
    dbName: "brainly",
})
    .then(() => {
    console.log("MongoDB connected");
})
    .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
});
app.use(express_1.default.json());
app.use((0, cors_1.default)());
app.post("/api/v1/signup", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const parsed = validation_1.signupSchema.parse(req.body);
        const existingUser = yield db_1.UserModel.findOne({ email: parsed.email });
        if (existingUser) {
            return res.status(409).json({ message: "User already exists" });
        }
        const hashedPassword = yield bcryptjs_1.default.hash(parsed.password, 10);
        yield db_1.UserModel.create({
            email: parsed.email,
            password: hashedPassword,
        });
        res.status(201).json({ message: "User signed up successfully" });
    }
    catch (err) {
        if (isZodError(err)) {
            return res.status(400).json({ errors: err.errors });
        }
        console.error(err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
app.post("/api/v1/signin", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const parsed = validation_1.signinSchema.parse(req.body);
        const user = yield db_1.UserModel.findOne({ email: parsed.email });
        if (!user) {
            return res.status(401).json({ message: "Invalid credentials" });
        }
        const isPasswordValid = yield bcryptjs_1.default.compare(parsed.password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ message: "Invalid credentials" });
        }
        const token = jsonwebtoken_1.default.sign({ id: user._id }, config_1.JWT_SECRET, { expiresIn: "7d" });
        res.json({ token });
    }
    catch (err) {
        if (isZodError(err)) {
            return res.status(400).json({ errors: err.errors });
        }
        console.error(err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
app.post("/api/v1/content", middleware_1.userMiddleware, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const parsed = validation_1.contentSchema.parse(req.body);
        yield db_1.ContentModel.create(Object.assign(Object.assign({}, parsed), { userId: req.userId, tags: [] }));
        res.status(201).json({ message: "Content added" });
    }
    catch (err) {
        if (isZodError(err)) {
            return res.status(400).json({ errors: err.errors });
        }
        console.error(err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
app.get("/api/v1/content", middleware_1.userMiddleware, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const content = yield db_1.ContentModel.find({
            userId: req.userId,
        }).populate("userId", "email");
        res.json({ content });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
app.delete("/api/v1/content", middleware_1.userMiddleware, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const contentId = req.body.contentId;
        if (!contentId) {
            return res.status(400).json({ message: "contentId is required" });
        }
        yield db_1.ContentModel.deleteOne({
            _id: contentId,
            userId: req.userId,
        });
        res.json({ message: "Content deleted" });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
app.post("/api/v1/brain/share", middleware_1.userMiddleware, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const share = req.body.share;
        if (share) {
            const existingLink = yield db_1.LinkModel.findOne({ userId: req.userId });
            if (existingLink) {
                return res.json({ hash: existingLink.hash });
            }
            const hash = (0, utils_1.random)(10);
            yield db_1.LinkModel.create({ userId: req.userId, hash });
            return res.json({ hash });
        }
        else {
            yield db_1.LinkModel.deleteOne({ userId: req.userId });
            return res.json({ message: "Removed link" });
        }
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
app.get("/api/v1/brain/:shareLink", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const hash = req.params.shareLink;
        const link = yield db_1.LinkModel.findOne({ hash });
        if (!link) {
            return res.status(404).json({ message: "Invalid share link" });
        }
        const content = yield db_1.ContentModel.find({ userId: link.userId });
        const user = yield db_1.UserModel.findById(link.userId);
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }
        res.json({ email: user.email, content });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ message: "Internal server error" });
    }
}));
app.listen(config_1.PORT, () => {
    console.log(`Server listening on port ${config_1.PORT}`);
});
