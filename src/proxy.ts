import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { checkLimits, logRequest, getKeyDetails } from "./db.js";
import { countTokens, calculateCost, extractPromptText } from "./utils.js";

export function registerProxyRoutes(fastify: FastifyInstance) {
  fastify.post("/v1/chat/completions", async (request: FastifyRequest, reply: FastifyReply) => {
    // 1. Authorization Header kontrolü
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return reply.code(401).send({
        error: { message: "Missing or invalid authorization header.", type: "invalid_request_error" }
      });
    }

    const keyId = authHeader.substring(7).trim();

    // 2. CapToken Anahtar Detaylarını Çek
    const keyDetails = await getKeyDetails(keyId);
    if (!keyDetails) {
      return reply.code(401).send({
        error: { message: "Invalid CapToken API key.", type: "invalid_request_error" }
      });
    }

    // 3. Limit ve Bütçe Kontrolü
    const limitCheck = await checkLimits(keyId);
    if (!limitCheck.allowed) {
      const statusCode = limitCheck.reason === "loop_detected" ? 429 : 402;
      return reply.code(statusCode).send({
        error: {
          message: `CapToken Blocked: ${limitCheck.reason}`,
          type: "rate_limit_error",
          code: limitCheck.reason
        }
      });
    }

    const body: any = request.body;
    const model = body.model || "unknown";
    const promptText = extractPromptText(body);
    const promptTokensEst = countTokens(promptText, model);

    // Sağlayıcıya göre hedef URL belirle
    let targetUrl = "https://api.openai.com/v1/chat/completions";
    if (keyDetails.provider === "gemini") {
      targetUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    }

    // Hedef API istek başlıklarını hazırla
    const targetHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${keyDetails.target_api_key}`
    };

    // Varsa organizasyon ve proje başlıklarını yönlendir (OpenAI için)
    if (request.headers["openai-organization"]) {
      targetHeaders["openai-organization"] = request.headers["openai-organization"] as string;
    }
    if (request.headers["openai-project"]) {
      targetHeaders["openai-project"] = request.headers["openai-project"] as string;
    }

    try {
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: targetHeaders,
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorJson;
        try { errorJson = JSON.parse(errorText); } catch { errorJson = { error: errorText }; }
        
        // Hatalı isteği 0 token ile logla
        await logRequest(keyId, model, promptTokensEst, 0, 0.0, response.status);
        
        return reply.code(response.status).send(errorJson);
      }

      const isStream = body.stream === true;

      if (!isStream) {
        // --- Standart (Non-streaming) Yanıt Modu ---
        const responseJson: any = await response.json();
        
        // OpenAI'dan gelen gerçek token kullanım verilerini al
        const promptTokens = responseJson.usage?.prompt_tokens || promptTokensEst;
        const completionTokens = responseJson.usage?.completion_tokens || 0;
        const cost = calculateCost(promptTokens, completionTokens, model);

        await logRequest(keyId, model, promptTokens, completionTokens, cost, response.status);

        return reply.send(responseJson);
      } else {
        // --- Stream (Akış/Yazma) Yanıt Modu ---
        reply.raw.writeHead(response.status, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("Response body is not readable");
        }

        const decoder = new TextDecoder();
        let accumulatedCompletionText = "";
        let finalPromptTokens = promptTokensEst;
        let finalCompletionTokens = 0;
        let usageFound = false;
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Gelen chunk'ı hemen kullanıcının bağlantısına yaz (Sıfır gecikme)
          reply.raw.write(value);

          // Chunk içeriğini metin olarak oku ve token analizi yap
          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // Son yarım satırı tamponda tut

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            
            const dataStr = trimmed.substring(6).trim();
            if (dataStr === "[DONE]") continue;

            try {
              const data = JSON.parse(dataStr);
              
              // Delta içeriği biriktir
              if (data.choices && data.choices[0]?.delta?.content) {
                accumulatedCompletionText += data.choices[0].delta.content;
              }

              // Eğer model stream_options.include_usage parametresiyle token bilgisi gönderdiyse al
              if (data.usage) {
                finalPromptTokens = data.usage.prompt_tokens;
                finalCompletionTokens = data.usage.completion_tokens;
                usageFound = true;
              }
            } catch (e) {
              // Yarım kalan JSON satırlarında hata fırlatmasını engelle
            }
          }
        }

        // Tamponda kalan son veri parçalarını işle
        if (buffer) {
          const trimmed = buffer.trim();
          if (trimmed.startsWith("data: ")) {
            const dataStr = trimmed.substring(6).trim();
            if (dataStr !== "[DONE]") {
              try {
                const data = JSON.parse(dataStr);
                if (data.choices && data.choices[0]?.delta?.content) {
                  accumulatedCompletionText += data.choices[0].delta.content;
                }
                if (data.usage) {
                  finalPromptTokens = data.usage.prompt_tokens;
                  finalCompletionTokens = data.usage.completion_tokens;
                  usageFound = true;
                }
              } catch (e) {}
            }
          }
        }

        reply.raw.end();

        // Eğer akış sırasında resmi kullanım nesnesi (usage) gelmediyse tiktoken ile hesapla
        if (!usageFound) {
          finalCompletionTokens = countTokens(accumulatedCompletionText, model);
        }

        const cost = calculateCost(finalPromptTokens, finalCompletionTokens, model);
        await logRequest(keyId, model, finalPromptTokens, finalCompletionTokens, cost, response.status);
      }
    } catch (error: any) {
      fastify.log.error(error);
      try { reply.raw.end(); } catch {}
      
      if (!reply.raw.headersSent) {
        return reply.code(500).send({
          error: { message: error.message || "Failed to proxy request", type: "api_error" }
        });
      }
    }
  });
}
