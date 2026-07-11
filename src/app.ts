import express from "express";
import cors from "cors";
import { success } from "./shared/envelope.js";
import { errorHandler } from "./shared/error-handler.js";

export const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json(success({ status: "ok" }));
});

app.use(errorHandler);
