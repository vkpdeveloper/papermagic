import { generateText, generateObject } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type { AppSettings } from "../src/types";

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
    {
      value: "gemini-3.1-pro-preview",
      label: "Gemini 3.1 Pro",
      description: "Most capable Google model",
    },
  ],
  openai: [
    {
      value: "gpt-5.4-nano",
      label: "GPT-5.4 Nano",
      description: "Cheapest and fastest - recommended",
    },
    {
      value: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      description: "Fast and capable",
    },
    { value: "gpt-5.4", label: "GPT-5.4", description: "Flagship model" },
  ],
  anthropic: [
    {
      value: "claude-haiku-4-5-20251001",
      label: "Claude Haiku 4.5",
      description: "Fastest and most affordable - recommended",
    },
    {
      value: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      description: "Best balance of speed and quality",
    },
    {
      value: "claude-opus-4-6",
      label: "Claude Opus 4.6",
      description: "Most capable Claude model",
    },
  ],
};

function buildModel(provider: AiProvider, modelId: string, apiKey: string) {
  switch (provider) {
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelId);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey });
      return openai(modelId);
    }
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelId);
    }
  }
}

const titleSchema = z.object({
  title: z
    .string()
    .describe("A concise, descriptive library card title for the document"),
});

export async function validateApiKey(
  provider: AiProvider,
  apiKey: string,
  modelId: string,
): Promise<boolean> {
  try {
    const model = buildModel(provider, modelId, apiKey);
    await generateText({
      model,
      prompt: "Reply with the single word: ok",
      maxOutputTokens: 100,
    });
    return true;
  } catch {
    return false;
  }
}

export async function generateDocumentTitle(
  contentSample: string,
  settings: AppSettings,
): Promise<string | null> {
  if (
    !settings.aiEnabled ||
    !settings.aiProvider ||
    !settings.aiModel ||
    !settings.aiApiKey
  ) {
    return null;
  }

  try {
    const model = buildModel(
      settings.aiProvider as AiProvider,
      settings.aiModel,
      settings.aiApiKey,
    );
    const { object } = await generateObject({
      model,
      schema: titleSchema,
      prompt: [
        "You are a librarian. Based on the following text excerpt from a document, generate a concise and descriptive title for the document.",
        "The title should be clear, specific, and suitable for a library card.",
        "No quotes, no explanation, no punctuation at the end.",
        "",
        "Text excerpt:",
        contentSample.slice(0, 2000),
      ].join("\n"),
      maxOutputTokens: 100,
    });

    const cleaned = object.title
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}
