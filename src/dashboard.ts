import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createApiKey, listApiKeys, deleteApiKey, toggleApiKey, getAnalytics, addTargetKey, deleteTargetKey, toggleTargetKey } from "./db.js";
import { generateAdminSession } from "./utils.js";

export function registerDashboardRoutes(fastify: FastifyInstance) {
  // Yönetici Giriş (Login)
  fastify.post("/api/login", async (request: FastifyRequest, reply: FastifyReply) => {
    const body: any = request.body;
    const adminPassword = process.env.ADMIN_PASSWORD || "admin";
    
    if (body && body.password === adminPassword) {
      const sessionToken = generateAdminSession();
      reply.header("Set-Cookie", `token=${sessionToken}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict`);
      return { success: true };
    } else {
      return reply.code(401).send({ error: "Geçersiz şifre!" });
    }
  });

  // Yönetici Çıkış (Logout)
  fastify.post("/api/logout", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Set-Cookie", "token=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict");
    return { success: true };
  });

  // Tüm API anahtarlarını listele
  fastify.get("/api/keys", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const keys = await listApiKeys();
      return keys;
    } catch (error: any) {
      return reply.code(500).send({ error: error.message || "Failed to list keys" });
    }
  });

  // Yeni API anahtarı ekle
  fastify.post("/api/keys", async (request: FastifyRequest, reply: FastifyReply) => {
    const body: any = request.body;
    if (!body.name || !body.target_api_key || body.daily_limit === undefined || body.monthly_limit === undefined) {
      return reply.code(400).send({ 
        error: "Missing required fields: name, target_api_key, daily_limit, monthly_limit" 
      });
    }

    try {
      const newKey = await createApiKey(
        body.name,
        body.target_api_key,
        body.provider || "openai",
        Number(body.daily_limit),
        Number(body.monthly_limit)
      );
      return newKey;
    } catch (error: any) {
      return reply.code(500).send({ error: error.message || "Failed to create key" });
    }
  });

  // API anahtarını sil
  fastify.delete("/api/keys/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    try {
      await deleteApiKey(id);
      return { success: true };
    } catch (error: any) {
      return reply.code(500).send({ error: error.message || "Failed to delete key" });
    }
  });

  // API anahtarını aktif/pasif yap
  fastify.patch("/api/keys/:id/toggle", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body: any = request.body;
    if (body.is_active === undefined) {
      return reply.code(400).send({ error: "Missing is_active field" });
    }

    try {
      await toggleApiKey(id, Boolean(body.is_active));
      return { success: true };
    } catch (error: any) {
      return reply.code(500).send({ error: error.message || "Failed to toggle key status" });
    }
  });

  // Analitik verilerini ve son logları getir
  fastify.get("/api/analytics", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const data = await getAnalytics();
      return data;
    } catch (error: any) {
      return reply.code(500).send({ error: error.message || "Failed to fetch analytics" });
    }
  });

  // Yeni hedef key ekle
  fastify.post("/api/keys/:id/targets", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body: any = request.body;
    if (!body.target_api_key || !body.provider) {
      return reply.code(400).send({ error: "Missing target_api_key or provider" });
    }
    try {
      const priority = body.priority !== undefined ? Number(body.priority) : 1;
      const target = await addTargetKey(id, body.target_api_key, body.provider, priority);
      return target;
    } catch (error: any) {
      return reply.code(500).send({ error: error.message || "Failed to add target key" });
    }
  });

  // Hedef key sil
  fastify.delete("/api/targets/:targetId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { targetId } = request.params as { targetId: string };
    try {
      await deleteTargetKey(targetId);
      return { success: true };
    } catch (error: any) {
      return reply.code(500).send({ error: error.message || "Failed to delete target key" });
    }
  });

  // Hedef key aktif/pasif yap
  fastify.patch("/api/targets/:targetId/toggle", async (request: FastifyRequest, reply: FastifyReply) => {
    const { targetId } = request.params as { targetId: string };
    const body: any = request.body;
    if (body.is_active === undefined) {
      return reply.code(400).send({ error: "Missing is_active field" });
    }
    try {
      await toggleTargetKey(targetId, Boolean(body.is_active));
      return { success: true };
    } catch (error: any) {
      return reply.code(500).send({ error: error.message || "Failed to toggle target key status" });
    }
  });
}
