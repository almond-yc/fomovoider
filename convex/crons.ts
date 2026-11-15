import { cronJobs } from "convex/server";
import { registerAppCrons } from "./retention";
import { registerXCrons } from "./x/crons";

// The shared cron registry: one register<X>Crons(crons) call per owner.
// See convex/README.md, "Connector crons".
const crons = cronJobs();
registerAppCrons(crons);
registerXCrons(crons);
export default crons;
