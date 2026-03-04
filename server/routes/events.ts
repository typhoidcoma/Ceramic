import { Router } from "express";
import { attachSseClient } from "../events";

export const eventsRouter = Router();

eventsRouter.get("/", (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const detach = attachSseClient(res);
  req.on("close", () => {
    detach();
  });
});
