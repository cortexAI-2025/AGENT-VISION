import type { ProviderConfig } from "../config.js";
import { resolveSecret } from "../config.js";

export interface CompletionInput {
  system: string;
  prompt: string;
  /** PNG, dans l'ordre. */
  images: Buffer[];
  maxTokens?: number;
}

export interface VisionProvider {
  readonly name: string;
  readonly model: string;
  readonly local: boolean;
  complete(input: CompletionInput): Promise<string>;
}

type FetchLike = typeof fetch;

async function postJson(f: FetchLike, url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`provider HTTP ${res.status}: ${text.slice(0, 300).replace(/(key|token)=\S+/gi, "$1=***")}`);
  return JSON.parse(text);
}

export class AnthropicProvider implements VisionProvider {
  readonly name = "anthropic";
  readonly local = false;
  constructor(readonly model: string, private readonly apiKey: string, private readonly baseUrl = "https://api.anthropic.com", private readonly f: FetchLike = fetch) {}
  async complete(i: CompletionInput): Promise<string> {
    const j = await postJson(this.f, `${this.baseUrl}/v1/messages`, { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" }, {
      model: this.model,
      max_tokens: i.maxTokens ?? 4096,
      system: i.system,
      messages: [{ role: "user", content: [
        ...i.images.map((b) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: b.toString("base64") } })),
        { type: "text", text: i.prompt },
      ] }],
    });
    return (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  }
}

/** OpenAI et tout serveur compatible : DeepSeek, xAI (Grok), Ollama, vLLM, LM Studio… */
export class OpenAICompatProvider implements VisionProvider {
  constructor(readonly name: string, readonly model: string, private readonly apiKey: string | undefined, private readonly baseUrl = "https://api.openai.com/v1", readonly local = false, private readonly f: FetchLike = fetch) {}
  async complete(i: CompletionInput): Promise<string> {
    const j = await postJson(this.f, `${this.baseUrl.replace(/\/$/, "")}/chat/completions`, this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}, {
      model: this.model,
      max_tokens: i.maxTokens ?? 4096,
      messages: [
        { role: "system", content: i.system },
        { role: "user", content: [
          ...i.images.map((b) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${b.toString("base64")}` } })),
          { type: "text", text: i.prompt },
        ] },
      ],
    });
    return j.choices?.[0]?.message?.content ?? "";
  }
}

export class GeminiProvider implements VisionProvider {
  readonly name = "gemini";
  readonly local = false;
  constructor(readonly model: string, private readonly apiKey: string, private readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta", private readonly f: FetchLike = fetch) {}
  async complete(i: CompletionInput): Promise<string> {
    const j = await postJson(this.f, `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`, { "x-goog-api-key": this.apiKey }, {
      systemInstruction: { parts: [{ text: i.system }] },
      contents: [{ role: "user", parts: [
        ...i.images.map((b) => ({ inlineData: { mimeType: "image/png", data: b.toString("base64") } })),
        { text: i.prompt },
      ] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: i.maxTokens ?? 4096 },
    });
    return (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
  }
}

/** Fournisseur de test : réponse fournie par une fonction. */
export class MockProvider implements VisionProvider {
  readonly name = "mock";
  readonly local = true;
  calls: CompletionInput[] = [];
  constructor(readonly model = "mock-1", private readonly respond: (i: CompletionInput) => string | Promise<string> = () => "{}") {}
  async complete(i: CompletionInput): Promise<string> {
    this.calls.push(i);
    return this.respond(i);
  }
}

export function createProvider(name: string, cfg: ProviderConfig, f: FetchLike = fetch): VisionProvider {
  const key = resolveSecret(cfg.apiKey);
  switch (cfg.type) {
    case "anthropic":
      if (!key) throw new Error(`provider ${name}: apiKey required`);
      return new AnthropicProvider(cfg.model, key, cfg.baseUrl, f);
    case "openai":
      return new OpenAICompatProvider(name, cfg.model, key, cfg.baseUrl, cfg.local, f);
    case "gemini":
      if (!key) throw new Error(`provider ${name}: apiKey required`);
      return new GeminiProvider(cfg.model, key, cfg.baseUrl, f);
    case "mock":
      return new MockProvider(cfg.model);
  }
}
