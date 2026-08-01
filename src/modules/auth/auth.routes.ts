import { Router } from "express";
import * as authController from "./auth.controller.js";

// Not mounted into app.ts yet — pending review (see chat).
export const authRouter = Router();

authRouter.post("/login", authController.login);
authRouter.post("/refresh", authController.refresh);
authRouter.post("/change-password", authController.changePassword);
authRouter.post("/logout", authController.logout);
