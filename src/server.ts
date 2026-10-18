import { buildApp } from "./app.js";
import { createBitnobClient } from "./bitnob/factory.js";
import { bitnobJournal } from "./bitnob/journal.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";

const config = loadConfig();
const db = openDatabase(config.databasePath);
const bitnob = createBitnobClient(config, bitnobJournal(db));
const bitnobEnv = config.bitnobMode === "live" ? "live" : "mock";
const app = await buildApp({ db, bitnob, config, bitnobEnv });

await app.listen({ host: "0.0.0.0", port: config.port });
