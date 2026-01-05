import { config as loadDotenv } from "dotenv";
import { createServer } from "./server.js";

loadDotenv();

const server = await createServer();

try {
  await server.listen({ port: server.config.PORT, host: server.config.HOST });
} catch (err) {
  server.log.error({ err }, "failed to start server");
  process.exit(1);
}
