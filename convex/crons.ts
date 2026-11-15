import { cronJobs } from "convex/server";
import { registerAppCrons } from "./retention";

// The shared cron registry: one register<X>Crons(crons) call per owner.
// See convex/README.md, "Connector crons".
const crons = cronJobs();
registerAppCrons(crons);
export default crons;
