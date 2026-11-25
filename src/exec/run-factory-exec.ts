import { main } from "./factory-exec.js";

process.exitCode = await main(process.argv.slice(2));
