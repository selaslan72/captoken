import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { checkLimits, logRequest, getKeyDetails } from "./db.js";
import { countTokens, calculateCost, extractPromptText, sendWebhookAlert } from "./utils.js";

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

    // 2. CapToken Anahtar Detaylarını Çek (Şifresi çözülmüş target_keys listesini de içerir)
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
      
      // Webhook uyarısı gönder
      sendWebhookAlert(`Sınır Aşımı / İstek Engellendi (${limitCheck.reason})`, {
        "Proxy Anahtarı": `captoken_...${keyId.substring(keyId.length - 8)}`,
        "Anahtar İsmi": keyDetails.name,
        "Engelleme Nedeni": limitCheck.reason,
        "Dönen HTTP Kodu": statusCode
      }).catch(err => console.error("Webhook notification failed:", err));

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

    // Aktif hedef anahtar kontrolü
    if (!keyDetails.targets || keyDetails.targets.length === 0) {
      return reply.code(400).send({
        error: { message: "No active target API keys configured for this proxy key.", type: "invalid_request_error" }
      });
    }

    let lastError: any = null;

    // --- Çoklu Hedef Anahtarlar Üzerinde Failover & Load Balancing Döngüsü ---
    for (let i = 0; i < keyDetails.targets.length; i++) {
      const target = keyDetails.targets[i];
      
      let targetUrl = "https://api.openai.com/v1/chat/completions";
      if (target.provider === "gemini") {
        targetUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
      }

      // Hedef API istek başlıklarını hazırla
      const targetHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${target.target_api_key}`
      };

      if (request.headers["openai-organization"]) {
        targetHeaders["openai-organization"] = request.headers["openai-organization"] as string;
      }
      if (request.headers["openai-project"]) {
        targetHeaders["openai-project"] = request.headers["openai-project"] as string;
      }

      try {
        console.log(`[Proxy] Trying target ${target.id} (${target.provider}) - Attempt ${i + 1}/${keyDetails.targets.length}`);
        
        const response = await fetch(targetUrl, {
          method: "POST",
          headers: targetHeaders,
          body: JSON.stringify(body)
        });

        // 429 (Rate Limit), 401 (Auth / Geçersiz Key) veya 5xx (Sunucu Hatası) durumunda yedek anahtara geç!
        if (!response.ok) {
          const isRateLimited = response.status === 429;
          const isServerErr = response.status >= 500;
          const isAuthErr = response.status === 401;

          if ((isRateLimited || isServerErr || isAuthErr) && i < keyDetails.targets.length - 1) {
            console.warn(`[Proxy] Target ${target.id} failed with status ${response.status}. Trying next target...`);
            
            // Webhook üzerinden yedek anahtara geçildiğini bildir
            sendWebhookAlert(`Hata Geçişi (Failover Tetiklendi)`, {
              "Proxy Anahtarı": `captoken_...${keyId.substring(keyId.length - 8)}`,
              "Hata Veren Sağlayıcı": target.provider,
              "Hata Kodu": response.status,
              "Durum": "Sistem otomatik olarak yedek anahtara geçiyor."
            }).catch(console.error);

            lastError = { status: response.status, provider: target.provider };
            continue; // Döngüye devam et, sıradaki key'i dene
          }
          
          // Son anahtar da başarısız olduysa veya kullanıcı hatası ise (örn: 400 Bad Request)
          const errorText = await response.text();
          let errorJson;
          try { errorJson = JSON.parse(errorText); } catch { errorJson = { error: errorText }; }
          
          await logRequest(keyId, model, promptTokensEst, 0, 0.0, response.status);
          return reply.code(response.status).send(errorJson);
        }

        // İstek başarılı olduysa yanıtı işle ve döngüden çık
        const isStream = body.stream === true;

        if (!isStream) {
          // --- Standart Yanıt Modu ---
          const responseJson: any = await response.json();
          const promptTokens = responseJson.usage?.prompt_tokens || promptTokensEst;
          const completionTokens = responseJson.usage?.completion_tokens || 0;
          const cost = calculateCost(promptTokens, completionTokens, model);

          await logRequest(keyId, model, promptTokens, completionTokens, cost, response.status);
          return reply.send(responseJson);
        } else {
          // --- Stream (Akış) Yanıt Modu ---
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

            reply.raw.write(value);

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data: ")) continue;
              
              const dataStr = trimmed.substring(6).trim();
              if (dataStr === "[DONE]") continue;

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

          if (!usageFound) {
            finalCompletionTokens = countTokens(accumulatedCompletionText, model);
          }

          const cost = calculateCost(finalPromptTokens, finalCompletionTokens, model);
          await logRequest(keyId, model, finalPromptTokens, finalCompletionTokens, cost, response.status);
          return;
        }
      } catch (error: any) {
        console.error(`[Proxy] Error for target ${target.id}:`, error.message);
        
        if (i < keyDetails.targets.length - 1) {
          lastError = error;
          continue; // Sıradaki yedek anahtarı dene
        }

        // Tüm anahtarlar network/istek hatası verdiyse
        try { reply.raw.end(); } catch {}
        await logRequest(keyId, model, promptTokensEst, 0, 0.0, 502);
        
        if (!reply.raw.headersSent) {
          return reply.code(502).send({
            error: { message: `Gateway Error: All target keys failed. Last error: ${error.message}`, type: "api_error" }
          });
        }
      }
    }
  });
}
