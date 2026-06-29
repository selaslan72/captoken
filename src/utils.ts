import { encodingForModel, getEncoding } from "js-tiktoken";

// Model bazlı fiyatlandırma tarifesi (1 Milyon Token Başına Dolar)
// Fiyatlar standart API maliyetlerine göre düzenlenmiştir.
interface Pricing {
  input: number;  // 1M token için giriş (prompt) fiyatı
  output: number; // 1M token için çıkış (completion) fiyatı
}

const MODEL_PRICING: Record<string, Pricing> = {
  // OpenAI
  "gpt-4o": { input: 2.50, output: 10.00 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4-turbo": { input: 10.00, output: 30.00 },
  "gpt-4": { input: 30.00, output: 60.00 },
  "gpt-3.5-turbo": { input: 0.50, output: 1.50 },

  // Anthropic Claude
  "claude-3-5-sonnet": { input: 3.00, output: 15.00 },
  "claude-3-5-haiku": { input: 0.80, output: 4.00 },
  "claude-3-opus": { input: 15.00, output: 75.00 },

  // Google Gemini
  "gemini-1.5-pro": { input: 1.25, output: 5.00 },
  "gemini-1.5-flash": { input: 0.075, output: 0.30 },
};

// Varsayılan model fiyatı (Bilinmeyen modeller için gpt-4o baz alınır)
const DEFAULT_PRICING: Pricing = { input: 2.50, output: 10.00 };

/**
 * Belirli bir metnin token sayısını js-tiktoken kullanarak hesaplar.
 */
export function countTokens(text: string, model: string): number {
  let encoder;
  try {
    // Model adına uygun encoder'ı bulmaya çalış
    encoder = encodingForModel(model as any);
  } catch {
    try {
      // Bulamazsa gpt-4o encoder'ını (o200k_base veya cl100k_base) kullan
      encoder = getEncoding("cl100k_base");
    } catch {
      // Fallback: kelime sayısı bazlı kaba hesaplama (yaklaşık 1 kelime = 1.3 token)
      return Math.ceil(text.split(/\s+/).length * 1.3);
    }
  }
  return encoder.encode(text).length;
}

/**
 * Girdi ve çıktı token adetlerine göre maliyeti Dolar ($) cinsinden hesaplar.
 */
export function calculateCost(promptTokens: number, completionTokens: number, model: string): number {
  // Model adını normalize et (versiyon numaralarını temizle örn: gpt-4o-2024-05-13 -> gpt-4o)
  let cleanModel = model.toLowerCase();
  
  // Model eşleşmesi bul
  let pricing = DEFAULT_PRICING;
  for (const key of Object.keys(MODEL_PRICING)) {
    if (cleanModel.includes(key)) {
      pricing = MODEL_PRICING[key];
      break;
    }
  }

  const promptCost = (promptTokens / 1_000_000) * pricing.input;
  const completionCost = (completionTokens / 1_000_000) * pricing.output;

  return parseFloat((promptCost + completionCost).toFixed(6));
}

/**
 * Sohbet istek gövdesinden (payload) tüm içeriği birleştirerek ham girdi metnini oluşturur.
 */
export function extractPromptText(body: any): string {
  if (!body || !body.messages || !Array.isArray(body.messages)) {
    return "";
  }
  
  let text = "";
  for (const message of body.messages) {
    if (message.content) {
      if (typeof message.content === "string") {
        text += message.content + "\n";
      } else if (Array.isArray(message.content)) {
        // Multimodal girdiler için metin parçalarını birleştir
        for (const part of message.content) {
          if (part.type === "text" && part.text) {
            text += part.text + "\n";
          }
        }
      }
    }
  }
  return text;
}
