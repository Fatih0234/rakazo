import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { listAvailablePiCatalog } from "./pi-catalog-availability.js";
import type { CodexCatalogModel } from "./pi-codex-catalog.js";
import {
  applyCodexLiveCatalog,
  CODEX_MODELS_ENDPOINT,
  CodexCatalogCache,
  codexCatalogAuthForSpace,
  codexLiveCatalogForSpace,
  fetchCodexCatalog,
  parseCodexCatalog,
} from "./pi-codex-catalog.js";
import type { PiCatalogEntry } from "./pi-models.js";
import { CHATGPT_OAUTH_PROVIDER } from "./pi-oauth.js";

const SPARK = "gpt-5.3-codex-spark";
const LUNA = "gpt-6-luna";
const ACCESS_TOKEN = "fake-access-token-for-tests";
const ACCOUNT_ID = "acct-test-1";

function liveModel(slug: string, extra: Partial<CodexCatalogModel> = {}): CodexCatalogModel {
  return {
    slug,
    reasoningEfforts: [],
    supportsImages: false,
    supportsFastTier: false,
    ...extra,
  };
}

function catalogPayload(models: unknown[]) {
  return { models };
}

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function codexEntry(entry: PiCatalogEntry | undefined): entry is PiCatalogEntry {
  return Boolean(entry);
}

function oauthPlaintext(access = ACCESS_TOKEN, expiresInMs = 3_600_000, accountId = ACCOUNT_ID) {
  return JSON.stringify({
    type: "oauth",
    access,
    refresh: "fake-refresh-token",
    expires: Date.now() + expiresInMs,
    accountId,
  });
}

function credentialRow(secretId: string, provider = CHATGPT_OAUTH_PROVIDER) {
  return {
    id: `credential-${secretId}`,
    userId: "user-1",
    provider,
    label: provider,
    secretId,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function authPrisma(options: {
  credentials?: ReturnType<typeof credentialRow>[];
  preferences?: Array<Record<string, unknown>>;
  secrets?: Array<{ id: string; ciphertext: string }>;
}) {
  return {
    userModelCredential: {
      findMany: vi.fn().mockResolvedValue(options.credentials ?? []),
    },
    spaceModelPreference: {
      findMany: vi.fn().mockResolvedValue(options.preferences ?? []),
    },
    secret: {
      findMany: vi
        .fn()
        .mockImplementation(async (args: { where: { id?: string | { in?: string[] } } }) => {
          const id = args.where.id;
          const ids = typeof id === "string" ? [id] : (id?.in ?? []);
          return (options.secrets ?? []).filter((row) => ids.includes(row.id));
        }),
      update: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaClient;
}

describe("fetchCodexCatalog", () => {
  it("requests the backend catalog with OAuth headers and the pinned client version", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(catalogPayload([])));

    const result = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, fetchImpl);

    expect(result.status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${CODEX_MODELS_ENDPOINT}?client_version=0.157.0`);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers.get("chatgpt-account-id")).toBe(ACCOUNT_ID);
    expect(headers.get("originator")).toBe("rakazo");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("returns typed http failures with the status code", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("nope", { status: 401, statusText: "Unauthorized" }),
    );
    const result = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, fetchImpl);
    expect(result).toEqual({ status: "error", reason: "http", httpStatus: 401 });
  });

  it("treats invalid JSON and missing models as malformed", async () => {
    const badJson = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, async () =>
      okResponse("<html>not json</html>"),
    );
    expect(badJson).toEqual({ status: "error", reason: "malformed" });

    const noModels = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, async () =>
      okResponse({ unexpected: true }),
    );
    expect(noModels).toEqual({ status: "error", reason: "malformed" });
  });

  it("caps the response body size via content-length", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 200,
          headers: { "content-length": String(2 * 1024 * 1024) },
        }),
    );
    const result = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, fetchImpl);
    expect(result).toEqual({ status: "error", reason: "malformed" });
  });

  it("caps the response body size while streaming", async () => {
    const chunk = new Uint8Array(1024).fill(65);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 1200; i += 1) controller.enqueue(chunk);
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(stream, { status: 200 }));
    const result = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, fetchImpl);
    expect(result).toEqual({ status: "error", reason: "malformed" });
  });

  it("maps abort timeouts and transport failures to typed reasons", async () => {
    const timeout = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(timeout).toEqual({ status: "error", reason: "timeout" });

    const transport = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, async () => {
      throw new Error("fetch failed");
    });
    expect(transport).toEqual({ status: "error", reason: "transport" });
  });

  it("never embeds credential material in failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error(`connection failed while sending ${ACCESS_TOKEN} for ${ACCOUNT_ID}`);
    });
    const result = await fetchCodexCatalog(ACCESS_TOKEN, ACCOUNT_ID, fetchImpl);
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain(ACCOUNT_ID);
  });
});

describe("parseCodexCatalog", () => {
  it("keeps only listed models that the API supports", () => {
    const parsed = parseCodexCatalog(
      catalogPayload([
        {
          slug: "gpt-5.4-mini",
          visibility: "list",
          supported_in_api: true,
          priority: 7,
          supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
          additional_speed_tiers: [],
          input_modalities: ["text", "image"],
          context_window: 272000,
        },
        {
          slug: "hidden",
          visibility: "hide",
          supported_in_api: true,
          supported_reasoning_levels: [],
          additional_speed_tiers: ["fast"],
          input_modalities: ["text"],
          context_window: 1,
        },
        {
          slug: "unsupported",
          visibility: "list",
          supported_in_api: false,
        },
      ]),
    );

    expect(parsed).toEqual([
      {
        slug: "gpt-5.4-mini",
        reasoningEfforts: ["low", "high"],
        contextWindow: 272000,
        supportsImages: true,
        supportsFastTier: false,
      },
    ]);
  });

  it("detects the fast tier", () => {
    const parsed = parseCodexCatalog(
      catalogPayload([
        {
          slug: SPARK,
          visibility: "list",
          supported_in_api: true,
          additional_speed_tiers: ["fast", "standard"],
          input_modalities: ["text"],
        },
      ]),
    );
    expect(parsed?.[0]?.supportsFastTier).toBe(true);
    expect(parsed?.[0]?.supportsImages).toBe(false);
  });

  it.each([
    ["non-object payload", "nope"],
    ["models not an array", { models: {} }],
    ["entry not an object", catalogPayload([42])],
    ["missing visibility", catalogPayload([{ slug: "x", supported_in_api: true }])],
    [
      "non-boolean supported_in_api",
      catalogPayload([{ visibility: "list", supported_in_api: "yes" }]),
    ],
    [
      "missing slug on a kept entry",
      catalogPayload([{ visibility: "list", supported_in_api: true }]),
    ],
    [
      "slug with a space",
      catalogPayload([{ slug: "not a slug", visibility: "list", supported_in_api: true }]),
    ],
    [
      "slug over the length bound",
      catalogPayload([{ slug: "x".repeat(1025), visibility: "list", supported_in_api: true }]),
    ],
    [
      "malformed reasoning level",
      catalogPayload([
        {
          slug: "ok",
          visibility: "list",
          supported_in_api: true,
          supported_reasoning_levels: [{ effort: "not valid!" }],
        },
      ]),
    ],
    [
      "negative context window",
      catalogPayload([
        { slug: "ok", visibility: "list", supported_in_api: true, context_window: -5 },
      ]),
    ],
    [
      "non-integer context window",
      catalogPayload([
        { slug: "ok", visibility: "list", supported_in_api: true, context_window: 1.5 },
      ]),
    ],
    [
      "non-string modality",
      catalogPayload([
        { slug: "ok", visibility: "list", supported_in_api: true, input_modalities: [3] },
      ]),
    ],
  ])("rejects malformed input: %s", (_name, payload) => {
    expect(parseCodexCatalog(payload)).toBeUndefined();
  });

  it("rejects a catalog over the model count bound", () => {
    const models = Array.from({ length: 129 }, (_, i) => ({
      slug: `model-${i}`,
      visibility: "list",
      supported_in_api: true,
    }));
    expect(parseCodexCatalog(catalogPayload(models))).toBeUndefined();
  });

  it("accepts a catalog at the model count bound", () => {
    const models = Array.from({ length: 128 }, (_, i) => ({
      slug: `model-${i}`,
      visibility: "list",
      supported_in_api: true,
    }));
    expect(parseCodexCatalog(catalogPayload(models))).toHaveLength(128);
  });
});

describe("CodexCatalogCache", () => {
  const account = (accessToken: string | null = ACCESS_TOKEN) => ({
    accountId: ACCOUNT_ID,
    accessToken: async () => accessToken,
  });

  function listFetch(slugs: string[] = [SPARK]) {
    return vi.fn<typeof fetch>(async () =>
      okResponse(
        catalogPayload(slugs.map((slug) => ({ slug, visibility: "list", supported_in_api: true }))),
      ),
    );
  }

  it("serves a fresh entry without refetching inside the TTL", async () => {
    let now = 1_000_000;
    const fetchImpl = listFetch();
    const cache = new CodexCatalogCache({ fetch: fetchImpl, now: () => now, waitMs: 50 });

    const first = await cache.read("user-1", account());
    expect(first?.map((model) => model.slug)).toEqual([SPARK]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 14 * 60_000;
    const second = await cache.read("user-1", account());
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("serves stale entries while revalidating in the background", async () => {
    let now = 1_000_000;
    let resolveSecond: ((response: Response) => void) | undefined;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
      )
      .mockImplementationOnce(
        async () => new Promise<Response>((resolve) => (resolveSecond = resolve)),
      )
      .mockImplementation(async () =>
        okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
      );
    const cache = new CodexCatalogCache({ fetch: fetchImpl, now: () => now, waitMs: 50 });

    await cache.read("user-1", account());
    now += 16 * 60_000;

    const stale = await cache.read("user-1", account());
    expect(stale?.map((model) => model.slug)).toEqual([SPARK]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    resolveSecond?.(
      okResponse(
        catalogPayload([
          { slug: SPARK, visibility: "list", supported_in_api: true },
          { slug: LUNA, visibility: "list", supported_in_api: true },
        ]),
      ),
    );
    await vi.waitFor(async () => {
      const next = await cache.read("user-1", account());
      expect(next?.map((model) => model.slug)).toEqual([SPARK, LUNA]);
    });
  });

  it("single-flights concurrent cold reads", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    const cache = new CodexCatalogCache({ fetch: fetchImpl, now: () => 0, waitMs: 2_000 });

    const reads = Promise.all([
      cache.read("user-1", account()),
      cache.read("user-1", account()),
      cache.read("user-1", account()),
    ]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    resolveFetch?.(
      okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
    );
    const results = await reads;
    for (const result of results) expect(result?.[0]?.slug).toBe(SPARK);
  });

  it("bounds the cold read wait and caches the eventual result", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    const cache = new CodexCatalogCache({ fetch: fetchImpl, now: () => 0, waitMs: 30 });

    const slow = await cache.read("user-1", account());
    expect(slow).toBeUndefined();

    resolveFetch?.(
      okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
    );
    await vi.waitFor(async () => {
      const later = await cache.read("user-1", account());
      expect(later?.[0]?.slug).toBe(SPARK);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a hung fetch never delays reads and later recovers", async () => {
    let now = 1_000_000;
    const hung = new Promise<Response>(() => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => hung)
      .mockImplementation(async () =>
        okResponse(catalogPayload([{ slug: SPARK, visibility: "list", supported_in_api: true }])),
      );
    const cache = new CodexCatalogCache({
      fetch: fetchImpl,
      now: () => now,
      waitMs: 20,
      deadlineMs: 40,
      failureTtlMs: 1_000,
    });

    const start = Date.now();
    const result = await cache.read("user-1", account());
    expect(result).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1_000);

    // Let the hard deadline retire the hung refresh, then move past the
    // failure TTL so the next read revalidates instead of serving the miss.
    await new Promise((resolve) => setTimeout(resolve, 80));
    now += 2_000;
    expect(await cache.read("user-1", account())).toBeUndefined();
    await vi.waitFor(async () => {
      const retry = await cache.read("user-1", account());
      expect(retry?.[0]?.slug).toBe(SPARK);
    });
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("negative-caches failures for the failure TTL", async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("x", { status: 503 }));
    const cache = new CodexCatalogCache({
      fetch: fetchImpl,
      now: () => now,
      waitMs: 50,
      failureTtlMs: 30_000,
    });

    expect(await cache.read("user-1", account())).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 10_000;
    expect(await cache.read("user-1", account())).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 30_000;
    expect(await cache.read("user-1", account())).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps catalogs isolated per (userId, accountId)", async () => {
    const fetchImpl = listFetch();
    const cache = new CodexCatalogCache({ fetch: fetchImpl, now: () => 0, waitMs: 50 });

    await cache.read("user-1", account());
    await cache.read("user-2", account());
    await cache.read("user-1", { accountId: "acct-other", accessToken: async () => ACCESS_TOKEN });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("treats an empty catalog as a failure so the static list stays", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(catalogPayload([])));
    const cache = new CodexCatalogCache({ fetch: fetchImpl, now: () => 0, waitMs: 50 });
    expect(await cache.read("user-1", account())).toBeUndefined();
  });

  it("records a failure when no access token resolves", async () => {
    const fetchImpl = listFetch();
    const cache = new CodexCatalogCache({ fetch: fetchImpl, now: () => 0, waitMs: 50 });
    expect(await cache.read("user-1", account(null))).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("codexCatalogAuthForSpace", () => {
  const scope = { userId: "user-1", spaceId: "space-1" };

  function secretsById(map: Record<string, string>) {
    return {
      load: vi.fn((ciphertext: string, id: string) => {
        const plaintext = map[ciphertext];
        if (plaintext === undefined) throw new Error(`unreadable ${id}`);
        return plaintext;
      }),
      put: vi.fn(async (plaintext: string, _ctx: unknown, id?: string) => ({
        id: id ?? "new-secret",
        ciphertext: `sealed:${plaintext.slice(0, 24)}`,
      })),
    };
  }

  it("resolves the provider-level OAuth credential into an account handle", async () => {
    const prisma = authPrisma({
      credentials: [credentialRow("secret-oauth")],
      secrets: [{ id: "secret-oauth", ciphertext: "cipher-oauth" }],
    });
    const secrets = secretsById({ "cipher-oauth": oauthPlaintext() });

    const account = await codexCatalogAuthForSpace(prisma, secrets, scope);

    expect(account?.accountId).toBe(ACCOUNT_ID);
    await expect(account?.accessToken()).resolves.toBe(ACCESS_TOKEN);
  });

  it("extracts the account id from the access JWT when the credential lacks it", async () => {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const access = `${b64({ alg: "none" })}.${b64({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-jwt" },
    })}.sig`;
    const prisma = authPrisma({
      credentials: [credentialRow("secret-oauth")],
      secrets: [{ id: "secret-oauth", ciphertext: "cipher-oauth" }],
    });
    const secrets = secretsById({
      "cipher-oauth": JSON.stringify({
        type: "oauth",
        access,
        refresh: "fake-refresh-token",
        expires: Date.now() + 3_600_000,
      }),
    });

    const account = await codexCatalogAuthForSpace(prisma, secrets, scope);

    expect(account?.accountId).toBe("acct-jwt");
  });

  it("refreshes a near-expiry credential and persists the rotated secret", async () => {
    const prisma = authPrisma({
      credentials: [credentialRow("secret-oauth")],
      secrets: [{ id: "secret-oauth", ciphertext: "cipher-oauth" }],
    });
    const secrets = secretsById({ "cipher-oauth": oauthPlaintext(ACCESS_TOKEN, 60_000) });
    const rotated: OAuthCredential = {
      type: "oauth",
      access: "rotated-access-token",
      refresh: "rotated-refresh-token",
      expires: Date.now() + 3_600_000,
      accountId: ACCOUNT_ID,
    };
    const oauth = {
      refresh: vi.fn(async () => rotated),
      toAuth: vi.fn(async () => ({ apiKey: rotated.access })),
    };

    const account = await codexCatalogAuthForSpace(prisma, secrets, scope, { oauth });

    expect(account).not.toBeNull();
    await expect(account!.accessToken()).resolves.toBe("rotated-access-token");
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
    expect(secrets.put).toHaveBeenCalledTimes(1);
    expect(prisma.secret.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "secret-oauth" } }),
    );
  });

  it("returns null without an OAuth credential, account id, or readable secret", async () => {
    const apiKeyOnly = authPrisma({
      credentials: [credentialRow("secret-api")],
      secrets: [{ id: "secret-api", ciphertext: "cipher-api" }],
    });
    const secrets = secretsById({ "cipher-api": "sk-test-plain-key" });
    expect(await codexCatalogAuthForSpace(apiKeyOnly, secrets, scope)).toBeNull();

    const noCredentials = authPrisma({ credentials: [], secrets: [] });
    expect(await codexCatalogAuthForSpace(noCredentials, secrets, scope)).toBeNull();

    const noAccountId = authPrisma({
      credentials: [credentialRow("secret-oauth")],
      secrets: [{ id: "secret-oauth", ciphertext: "cipher-oauth" }],
    });
    const missingAccount = secretsById({
      "cipher-oauth": JSON.stringify({
        type: "oauth",
        access: "opaque-token",
        refresh: "fake-refresh-token",
        expires: Date.now() + 3_600_000,
      }),
    });
    expect(await codexCatalogAuthForSpace(noAccountId, missingAccount, scope)).toBeNull();

    const broken = authPrisma({
      credentials: [credentialRow("secret-broken")],
      secrets: [{ id: "secret-broken", ciphertext: "cipher-broken" }],
    });
    expect(await codexCatalogAuthForSpace(broken, secretsById({}), scope)).toBeNull();
  });

  it("falls back to the credential owning an OAuth model preference", async () => {
    const prisma = authPrisma({
      credentials: [
        credentialRow("secret-api"),
        { ...credentialRow("secret-oauth"), updatedAt: new Date("2026-02-01T00:00:00.000Z") },
      ],
      preferences: [
        {
          id: "pref-spark",
          modelId: SPARK,
          isDefault: false,
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
          credential: credentialRow("secret-oauth"),
        },
      ],
      secrets: [
        { id: "secret-api", ciphertext: "cipher-api" },
        { id: "secret-oauth", ciphertext: "cipher-oauth" },
      ],
    });
    const secrets = secretsById({
      "cipher-api": "sk-test-plain-key",
      "cipher-oauth": oauthPlaintext(),
    });

    const account = await codexCatalogAuthForSpace(prisma, secrets, scope, {
      modelIds: [SPARK],
    });

    expect(account?.accountId).toBe(ACCOUNT_ID);
  });
});

describe("codexLiveCatalogForSpace", () => {
  const scope = { userId: "user-1", spaceId: "space-1" };

  it("reads the catalog only for spaces with OAuth-governed codex models", async () => {
    const prisma = authPrisma({
      credentials: [credentialRow("secret-oauth")],
      secrets: [{ id: "secret-oauth", ciphertext: "cipher-oauth" }],
    });
    const secrets = {
      load: () => oauthPlaintext(),
      put: vi.fn(),
    };
    const read = vi.fn(async () => [liveModel(SPARK)]);
    const catalog = { read };

    const live = await codexLiveCatalogForSpace(
      prisma,
      secrets,
      scope,
      { byProvider: { [CHATGPT_OAUTH_PROVIDER]: "oauth" }, byModel: {} },
      catalog,
    );

    expect(live?.[0]?.slug).toBe(SPARK);
    expect(read).toHaveBeenCalledWith("user-1", expect.objectContaining({ accountId: ACCOUNT_ID }));
  });

  it("skips the catalog when no OAuth kind governs a codex model", async () => {
    const read = vi.fn(async () => [liveModel(SPARK)]);
    const prisma = authPrisma({
      credentials: [credentialRow("secret-api")],
      secrets: [{ id: "secret-api", ciphertext: "cipher-api" }],
    });
    const secrets = { load: () => "sk-test-plain-key", put: vi.fn() };

    const live = await codexLiveCatalogForSpace(
      prisma,
      secrets,
      scope,
      { byProvider: { [CHATGPT_OAUTH_PROVIDER]: "api_key" }, byModel: {} },
      { read },
    );

    expect(live).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("applyCodexLiveCatalog", () => {
  const oauthAuth = {
    byProvider: { [CHATGPT_OAUTH_PROVIDER]: "oauth" as const },
    byModel: {},
  };
  const base = listAvailablePiCatalog(oauthAuth.byProvider, oauthAuth.byModel);

  it("restores statically excluded models the account can call", () => {
    expect(
      base.some((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === SPARK),
    ).toBe(false);
    const merged = applyCodexLiveCatalog(base, oauthAuth, [liveModel(SPARK), liveModel(LUNA)]);

    const ids = merged
      .filter((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER)
      .map((entry) => entry.id);
    expect(ids).toEqual([SPARK, LUNA]);

    const spark = merged.find(
      (entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === SPARK,
    );
    expect(spark?.auth).toBe("oauth");
    expect(spark?.label).toBeTruthy();
    expect(spark?.billing).toBeTruthy();
  });

  it("drops OAuth-governed models the live catalog does not list", () => {
    const merged = applyCodexLiveCatalog(base, oauthAuth, [liveModel(LUNA)]);
    const codexIds = merged
      .filter((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER)
      .map((entry) => entry.id);
    expect(codexIds).toEqual([LUNA]);
  });

  it("synthesizes catalog entries for models the static catalog lacks", () => {
    const merged = applyCodexLiveCatalog(base, oauthAuth, [
      liveModel(LUNA),
      liveModel("gpt-7-codex-new", { reasoningEfforts: ["low", "high", "not-a-level"] }),
    ]);

    const extra = merged
      .filter((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER)
      .find((entry) => entry.id === "gpt-7-codex-new");
    expect(extra).toBeDefined();
    expect(extra?.auth).toBe("oauth");
    expect(extra?.subscription).toBe(true);
    expect(extra?.reasoning).toBe(true);
    expect(extra?.thinkingLevels).toEqual(["low", "high"]);
    expect(extra?.label).toBe("gpt-7-codex-new");
  });

  it("overrides thinking levels only when the endpoint supplies known efforts", () => {
    const staticEntry = listAvailablePiCatalog()
      .concat(base)
      .find(
        (entry): entry is PiCatalogEntry =>
          codexEntry(entry) && entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === LUNA,
      )!;
    const merged = applyCodexLiveCatalog(base, oauthAuth, [
      liveModel(LUNA, { reasoningEfforts: ["minimal", "medium"] }),
    ]);
    const liveEntry = merged.find(
      (entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === LUNA,
    );
    expect(liveEntry?.thinkingLevels).toEqual(["minimal", "medium"]);

    const mergedUnknown = applyCodexLiveCatalog(base, oauthAuth, [
      liveModel(LUNA, { reasoningEfforts: ["mystery-effort"] }),
    ]);
    const fallback = mergedUnknown.find(
      (entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === LUNA,
    );
    expect(fallback?.thinkingLevels).toEqual(staticEntry.thinkingLevels);
  });

  it("keeps API-key-governed codex models outside the live gate", () => {
    const mixedAuth = {
      byProvider: { [CHATGPT_OAUTH_PROVIDER]: "oauth" as const },
      byModel: { [CHATGPT_OAUTH_PROVIDER]: { [SPARK]: "api_key" as const } },
    };
    const mixedBase = listAvailablePiCatalog(mixedAuth.byProvider, mixedAuth.byModel);
    const merged = applyCodexLiveCatalog(mixedBase, mixedAuth, [liveModel(LUNA)]);

    const codexIds = merged
      .filter((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER)
      .map((entry) => entry.id);
    expect(codexIds).toContain(SPARK);
    expect(codexIds).toEqual([SPARK, LUNA]);
  });

  it("ignores a live catalog sharing no slug with the static codex catalog", () => {
    const foreign = [liveModel("some-unrelated-model"), liveModel("another-foreign")];
    expect(applyCodexLiveCatalog(base, oauthAuth, foreign)).toEqual(base);
  });

  it("leaves other providers untouched", () => {
    const merged = applyCodexLiveCatalog(base, oauthAuth, [liveModel(LUNA)]);
    const otherProviders = merged.filter((entry) => entry.provider !== CHATGPT_OAUTH_PROVIDER);
    expect(otherProviders).toEqual(
      base.filter((entry) => entry.provider !== CHATGPT_OAUTH_PROVIDER),
    );
  });
});
