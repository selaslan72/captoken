import { encodingForModel, getEncoding } from "js-tiktoken";
import crypto from "crypto";

// ... (existing pricing mapping stays same)


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

// ENCRYPTION_KEY'den sha256 kullanarak 32-byte'lık anahtar türetir
const getEncryptionKey = (): Buffer => {
  const secret = process.env.ENCRYPTION_KEY || "default_captoken_encryption_key_32bytes_long";
  return crypto.createHash("sha256").update(secret).digest();
};

/**
 * Metni AES-256-CBC algoritmasıyla şifreler.
 */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", getEncryptionKey(), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${encrypted}`;
}

/**
 * Şifrelenmiş metni çözer. Hata alırsa veya şifresiz ise düz metin (plaintext) olarak döner.
 */
export function decrypt(text: string): string {
  try {
    const parts = text.split(":");
    if (parts.length !== 2) {
      return text;
    }
    const iv = Buffer.from(parts[0], "hex");
    const encryptedText = parts[1];
    const decipher = crypto.createDecipheriv("aes-256-cbc", getEncryptionKey(), iv);
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (error) {
    return text;
  }
}

/**
 * Slack veya Discord webhook adresine markdown formatında zengin içerikli uyarı gönderir.
 */
export async function sendWebhookAlert(message: string, details: Record<string, any>) {
  const webhookUrl = process.env.GLOBAL_WEBHOOK_URL;
  if (!webhookUrl) {
    return;
  }

  const payload = {
    text: `⚠️ *CapToken Güvenlik/Bütçe Uyarısı* ⚠️\n\n*Durum:* ${message}\n` +
          Object.entries(details).map(([k, v]) => `*${k}:* \`${v}\``).join("\n") +
          `\n\n📅 _Zaman: ${new Date().toLocaleString('tr-TR')}_`
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.error(`Webhook sending failed: ${res.status} - ${await res.text()}`);
    }
  } catch (err: any) {
    console.error(`Webhook sending error: ${err.message}`);
  }
}

/**
 * Yönetici oturumu için imzalı bir session token oluşturur (24 saat geçerli).
 */
export function generateAdminSession(): string {
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  const sessionData = `admin:${expiresAt}`;
  const secret = process.env.ENCRYPTION_KEY || "default_auth_secret";
  const signature = crypto.createHmac("sha256", secret).update(sessionData).digest("hex");
  return `${sessionData}:${signature}`;
}

/**
 * Oturum token'ını doğrular.
 */
export function verifyAdminSession(token: string): boolean {
  try {
    const parts = token.split(":");
    if (parts.length !== 3) {
      return false;
    }
    const sessionData = `${parts[0]}:${parts[1]}`;
    const signature = parts[2];
    
    const secret = process.env.ENCRYPTION_KEY || "default_auth_secret";
    const expectedSignature = crypto.createHmac("sha256", secret).update(sessionData).digest("hex");
    
    if (signature !== expectedSignature) {
      return false;
    }

    const expiresAt = parseInt(parts[1], 10);
    if (Date.now() > expiresAt) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
