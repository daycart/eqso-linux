import { Router, type IRouter } from "express";
import healthRouter from "./health";
import eqsoRouter from "./eqso";
import authRouter from "./auth";
import adminRouter from "./admin";
import { publicServersRouter, adminServersRouter } from "./servers";
import { adminRelaysRouter } from "./relays";
import { relayTokensRouter } from "./relay-tokens";
import { relayOperatorRouter } from "./relay-operator";
import bulletinsRouter from "./bulletins";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/eqso", eqsoRouter);
router.use("/auth", authRouter);
router.use("/admin", adminRouter);
router.use("/admin", adminServersRouter);
router.use("/admin", adminRelaysRouter);
router.use("/admin", relayTokensRouter);
router.use("/relay-operator", relayOperatorRouter);
router.use("/admin", bulletinsRouter);
router.use(publicServersRouter);

export default router;
