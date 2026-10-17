import Fastify from "fastify";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);

const app = Fastify({ logger: true });

app.get("/api/health", async () => ({
  ok: true,
  bitnob: "not-wired",
  hint: "Implémenter selon SPEC.md",
}));

await app.register(fastifyStatic, {
  root: join(__dirname, "..", "public"),
  wildcard: false,
});

app.setNotFoundHandler((_req, reply) => {
  return reply.sendFile("index.html");
});

await app.listen({ host: "0.0.0.0", port });
console.log(`jaaykat-api listening on :${port}`);
