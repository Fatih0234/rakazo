export function computerTestSandbox(provider = "box") {
  if (provider === "box") return { provider, apiKeyEnv: "BOX_API_KEY" } as const;
  throw new Error("Live computer tests support --sandbox box");
}
