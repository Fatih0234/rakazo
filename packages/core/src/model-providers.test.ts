import type { ModelCatalogEntry } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  featuredModelProviders,
  filterModelCatalog,
  selectedProviderOutsideSearchResults,
} from "./model-providers.js";

function provider(provider: string): ModelCatalogEntry {
  return {
    provider,
    providerName: provider,
    id: `${provider}-model`,
    label: `${provider} model`,
    billing: "",
  };
}

describe("featuredModelProviders", () => {
  it("shows popular providers in a stable order", () => {
    const providers = [
      provider("azure"),
      provider("vercel-ai-gateway"),
      provider("google"),
      provider("openai"),
      provider("anthropic"),
      provider("openai-codex"),
      provider("openrouter"),
    ];

    expect(featuredModelProviders(providers, "openrouter").map((entry) => entry.provider)).toEqual([
      "openrouter",
      "openai-codex",
      "anthropic",
      "openai",
      "google",
      "vercel-ai-gateway",
    ]);
  });

  it("fills missing popular slots from the catalog", () => {
    const providers = [
      provider("azure"),
      provider("openrouter"),
      provider("bedrock"),
      provider("anthropic"),
    ];

    expect(featuredModelProviders(providers, "openrouter").map((entry) => entry.provider)).toEqual([
      "openrouter",
      "anthropic",
      "azure",
      "bedrock",
    ]);
  });

  it("keeps a non-featured selected provider visible", () => {
    const providers = [
      provider("openrouter"),
      provider("openai-codex"),
      provider("anthropic"),
      provider("openai"),
      provider("google"),
      provider("vercel-ai-gateway"),
      provider("local"),
    ];

    expect(featuredModelProviders(providers, "local").map((entry) => entry.provider)).toEqual([
      "openrouter",
      "openai-codex",
      "anthropic",
      "openai",
      "google",
      "local",
    ]);
  });
});

describe("selectedProviderOutsideSearchResults", () => {
  it("returns the active provider separately from unrelated search results", () => {
    const providers = [provider("openrouter"), provider("anthropic"), provider("bedrock")];

    expect(
      selectedProviderOutsideSearchResults(providers.slice(1), providers, "openrouter"),
    ).toMatchObject({ provider: "openrouter" });
  });

  it("returns nothing when the active provider matches the search", () => {
    const providers = [provider("openrouter"), provider("anthropic")];

    expect(
      selectedProviderOutsideSearchResults(providers, providers, "openrouter"),
    ).toBeUndefined();
  });
});

describe("filterModelCatalog", () => {
  const models: ModelCatalogEntry[] = [
    {
      provider: "openrouter",
      providerName: "OpenRouter",
      id: "anthropic/claude-sonnet",
      label: "Claude Sonnet",
      billing: "",
    },
    { provider: "openrouter", id: "openai/gpt-mini", label: "GPT Mini", billing: "" },
  ];

  it("keeps every model for a blank query", () => {
    expect(filterModelCatalog(models, "")).toBe(models);
    expect(filterModelCatalog(models, "   ")).toBe(models);
  });

  it("matches the label, id, or provider name, ignoring case and surrounding space", () => {
    expect(filterModelCatalog(models, " sonnet ").map((entry) => entry.id)).toEqual([
      "anthropic/claude-sonnet",
    ]);
    expect(filterModelCatalog(models, "OPENAI/").map((entry) => entry.id)).toEqual([
      "openai/gpt-mini",
    ]);
    expect(filterModelCatalog(models, "OpenRouter").map((entry) => entry.id)).toEqual([
      "anthropic/claude-sonnet",
      "openai/gpt-mini",
    ]);
  });

  it("falls back to the provider id when there is no provider name", () => {
    expect(filterModelCatalog([models[1]!], "router")).toHaveLength(1);
  });

  it("returns nothing when no model matches", () => {
    expect(filterModelCatalog(models, "gemini")).toEqual([]);
  });
});
