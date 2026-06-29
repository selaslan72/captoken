import fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { initDB } from "./db.js";
import { registerProxyRoutes } from "./proxy.js";
import { registerDashboardRoutes } from "./dashboard.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const server = fastify({
  logger: true,
  bodyLimit: 10485760, // Ajanlar için 10MB payload sınırı
});

async function main() {
  try {
    // 1. Veritabanını ilklendir
    await initDB();

    // 2. CORS desteğini aktif et
    await server.register(cors, {
      origin: true,
    });

    // 3. Kontrol Paneli (Frontend) için statik dosyaları sun
    await server.register(fastifyStatic, {
      root: path.resolve(__dirname, "../public"),
      prefix: "/",
    });

    // 4. Rotaları kaydet
    registerProxyRoutes(server);
    registerDashboardRoutes(server);

    // 5. Sunucuyu dinlemeye başla
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    const host = process.env.HOST || "0.0.0.0";
    
    await server.listen({ port, host });
    console.log(`\n🚀 CapToken Gateway is ready at http://localhost:${port}\n`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
