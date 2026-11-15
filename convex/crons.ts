import { cronJobs } from "convex/server";
import { registerInstagramCrons } from "./instagram/crons";
import { registerAppCrons } from "./retention";
import { registerTelegramCrons } from "./telegram/crons";
import { registerXCrons } from "./x/crons";

// The shared cron registry: one register<X>Crons(crons) call per owner.
// See convex/README.md, "Connector crons".
const crons = cronJobs();
registerAppCrons(crons);
registerXCrons(crons);
registerTelegramCrons(crons);
registerInstagramCrons(crons);
export default crons;
