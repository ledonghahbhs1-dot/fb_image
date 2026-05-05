import { Router, type IRouter } from "express";
import healthRouter from "./health";
import facebookRouter from "./facebook";

const router: IRouter = Router();

router.use(healthRouter);
router.use(facebookRouter);

export default router;
