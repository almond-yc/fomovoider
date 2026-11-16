import workflow from "@convex-dev/workflow/convex.config.js";
import workpool from "@convex-dev/workpool/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
// The Morning Brief: one durable workflow per user per day (brief/workflow.ts),
// and its own pool for the model calls so judging never starves other work.
app.use(workflow);
app.use(workpool, { name: "briefJudgePool" });
export default app;
