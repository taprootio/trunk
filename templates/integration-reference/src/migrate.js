import { loadConfig } from "./config.js";
import { ReferenceDatabase } from "./database.js";

const config = loadConfig();
if (config.bootstrapManifestOnly) {
  throw new Error("Migrations are unavailable in manifest-only bootstrap mode.");
}
const database = new ReferenceDatabase(config.databaseUrl, config.webhookLimits, config.databaseCaCertificate);
try {
  await database.migrate();
  process.stdout.write("Migrations applied.\n");
} finally {
  await database.close();
}
