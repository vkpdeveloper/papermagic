export type AiProvider = "google" | "openai" | "anthropic";

export interface ProviderModel {
  value: string;
  label: string;
  description: string;
}

export const PROVIDER_MODELS: Record<AiProvider, ProviderModel[]> = {
  google: [
    {
      value: "gemini-2.5-flash-lite",
      label: "Gemini 2.5 Flash Lite",
      description: "Lightest, fastest & cheapest",
    },
    {
      value: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      description: "Fast and efficient — recommended",
    },
    {
      value: "gemini-3.1-flash-lite-preview",
      label: "Gemini 3.1 Flash Lite",
      description: "New lightest & fastest",
    },
    {
      value: "gemini-3-flash-preview",
      label: "Gemini 3 Flash",
      description: "New fast and efficient",
    },
  ],
  openai: [
    {
      value: "gpt-4o-mini",
      label: "GPT-4o Mini",
      description: "Fast and affordable — recommended",
    },
    { value: "gpt-4o", label: "GPT-4o", description: "Most capable GPT model" },
  ],
  anthropic: [
    {
      value: "claude-haiku-4-5-20251001",
      label: "Claude Haiku 4.5",
      description: "Fastest and most affordable — recommended",
    },
    {
      value: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      description: "Best balance of speed and quality",
    },
  ],
};

export async function validateApiKey(
  provider: AiProvider,
  apiKey: string,
  modelId: string,
): Promise<boolean> {
  try {
    if (provider === "google") {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: "ok" }] }] }),
        },
      );
      return res.ok;
    }
    if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "ok" }],
          max_tokens: 5,
        }),
      });
      return res.ok;
    }
    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 5,
          messages: [{ role: "user", content: "ok" }],
        }),
      });
      return res.ok;
    }
    return false;
  } catch {
    return false;
  }
}

// Kept for potential future use; not called by current importers
export async function generateDocumentTitle(): Promise<string | null> {
  return null;
}
