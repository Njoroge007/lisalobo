import { Router, type IRouter } from "express";
import healthRouter from "./health";
import v75Router from "./v75";
import authRouter from "./auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(v75Router);
router.use(authRouter);

export default router;
