import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createApiKey, listApiKeys, deleteApiKey, toggleApiKey, getAnalytics } from "./db.js";

export function registerDashboardRoutes(fastify: FastifyInstance) {
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
}
