import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@rakazo/contracts";
import { ThinkingLevelSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { findModelCredential } from "@rakazo/db";
import type { ModelCredentialAuthKind } from "./pi-catalog-availability.js";
import type { PiCatalogEntry } from "./pi-models.js";
import { catalogModelLabel, listPiCatalog } from "./pi-models.js";
import type { StoredModelSecret } from "./pi-oauth.js";
import { CHATGPT_OAUTH_PROVIDER, parseModelSecret, resolveModelAuth } from "./pi-oauth.js";
import type { EncryptedSecretStore } from "./secrets.js";

/**
 * The ChatGPT backend reports which Codex models a subscription account can call.
 * fx resolves `client_version` from npm `@openai/codex@latest`; we pin a recent
 * CLI release (0.157.0 shipped GPT-6 Sol/Luna) so reads stay deterministic — bump
 * the constant to ask the backend for a newer compatibility view.
 */
export const CODEX_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models";
const CODEX_CLIENT_VERSION = "0.157.0";

const CODEX_CATALOG_TIMEOUT_MS = 12_000;
const CODEX_CATALOG_HARD_DEADLINE_MS = CODEX_CATALOG_TIMEOUT_MS + 10_000;
const CODEX_CATALOG_MAX_BYTES = 1024 * 1024;
const MAX_CODEX_MODELS = 128;
const MAX_CODEX_LIST_ITEMS = 32;
const MAX_REASONING_LEVELS = 16;
const MAX_CATALOG_CACHE_ENTRIES = 256;
const CATALOG_TTL_MS = 15 * 60_000;
const CATALOG_FAILURE_TTL_MS = 60_000;
const CATALOG_READ_WAIT_MS = 1_500;

export type CodexCatalogModel = {
  slug: string;
  reasoningEfforts: string[];
  contextWindow?: number;
  supportsImages: boolean;
  supportsFastTier: boolean;
};

export type CodexCatalogFailureReason = "transport" | "timeout" | "http" | "malformed";

export type CodexCatalogResult =
  | { status: "ok"; models: CodexCatalogModel[] }
  | { status: "error"; reason: CodexCatalogFailureReason; httpStatus?: number };

/** Account-scoped handle for one catalog read. `accessToken` may refresh lazily. */
export type CodexCatalogAccount = {
  accountId: string;
  accessToken: () => Promise<string | null>;
};

export interface CodexLiveCatalog {
  read(userId: string, account: CodexCatalogAccount): Promise<CodexCatalogModel[] | undefined>;
}

/** GET the backend's per-account model list. Failure modes are typed, never thrown. */
export async function fetchCodexCatalog(
  accessToken: string,
  accountId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexCatalogResult> {
  const url = `${CODEX_MODELS_ENDPOINT}?client_version=${CODEX_CLIENT_VERSION}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        originator: "rakazo",
        accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(CODEX_CATALOG_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { status: "error", reason: name === "TimeoutError" ? "timeout" : "transport" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { status: "error", reason: "http", httpStatus: response.status };
  }
  const text = await readBoundedText(response);
  if (text === undefined) return { status: "error", reason: "malformed" };
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { status: "error", reason: "malformed" };
  }
  const models = parseCodexCatalog(payload);
  return models ? { status: "ok", models } : { status: "error", reason: "malformed" };
}

async function readBoundedText(response: Response): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > CODEX_CATALOG_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > CODEX_CATALOG_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    return undefined;
  }
}

const INVALID = Symbol("invalid-codex-catalog");

/**
 * Parse the backend response: keep only `visibility === "list" && supported_in_api`.
 * Any malformed entry fails the whole catalog so a broken response cannot wipe the list.
 */
export function parseCodexCatalog(payload: unknown): CodexCatalogModel[] | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models) || models.length > MAX_CODEX_MODELS) return undefined;
  const catalog: CodexCatalogModel[] = [];
  for (const item of models) {
    if (!item || typeof item !== "object") return undefined;
    const entry = item as Record<string, unknown>;
    if (typeof entry.visibility !== "string" || typeof entry.supported_in_api !== "boolean") {
      return undefined;
    }
    if (entry.visibility !== "list" || !entry.supported_in_api) continue;
    if (typeof entry.slug !== "string" || !isValidSlug(entry.slug)) return undefined;
    const reasoningEfforts = parseReasoningEfforts(entry.supported_reasoning_levels);
    const contextWindow = parseContextWindow(entry.context_window);
    const supportsImages = stringListContains(entry.input_modalities, "image");
    const supportsFastTier = stringListContains(entry.additional_speed_tiers, "fast");
    if (
      reasoningEfforts === INVALID ||
      contextWindow === INVALID ||
      supportsImages === INVALID ||
      supportsFastTier === INVALID
    ) {
      return undefined;
    }
    catalog.push({
      slug: entry.slug,
      reasoningEfforts,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      supportsImages,
      supportsFastTier,
    });
  }
  return catalog;
}

/** Printable non-space ASCII only, bounded length. */
function isValidSlug(slug: string): boolean {
  return /^[\x21-\x7e]{1,1024}$/.test(slug);
}

function parseReasoningEfforts(value: unknown): string[] | typeof INVALID {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_REASONING_LEVELS) return INVALID;
  const efforts: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return INVALID;
    const effort = (entry as Record<string, unknown>).effort;
    if (typeof effort !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(effort)) return INVALID;
    efforts.push(effort);
  }
  return efforts;
}

function parseContextWindow(value: unknown): number | undefined | typeof INVALID {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    return INVALID;
  }
  return value;
}

function stringListContains(value: unknown, expected: string): boolean | typeof INVALID {
  if (value === undefined || value === null) return false;
  if (!Array.isArray(value) || value.length > MAX_CODEX_LIST_ITEMS) return INVALID;
  let found = false;
  for (const entry of value) {
    if (typeof entry !== "string") return INVALID;
    if (entry === expected) found = true;
  }
  return found;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CodexCatalogCacheEntry =
  | { ok: true; models: CodexCatalogModel[]; expiresAt: number }
  | { ok: false; expiresAt: number };

/**
 * In-memory per (userId, accountId) catalog with a single in-flight refresh per key.
 * Reads never block past `waitMs`: a fresh hit returns immediately, a stale hit serves
 * the last good list while a background refresh runs, and a cold miss waits a short
 * bounded time before giving up. Failures are cached briefly to avoid a retry storm.
 * Process-lifetime only — restart loses the catalog until the next fetch.
 */
export class CodexCatalogCache implements CodexLiveCatalog {
  private readonly entries = new Map<string, CodexCatalogCacheEntry>();
  private readonly inflight = new Map<string, Promise<CodexCatalogModel[] | undefined>>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly waitMs: number;
  private readonly deadlineMs: number;

  constructor(
    opts: {
      fetch?: typeof fetch;
      now?: () => number;
      ttlMs?: number;
      failureTtlMs?: number;
      waitMs?: number;
      /** Bound on the shared refresh itself, so a signal-ignoring fetch cannot pin a key. */
      deadlineMs?: number;
    } = {},
  ) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? CATALOG_TTL_MS;
    this.failureTtlMs = opts.failureTtlMs ?? CATALOG_FAILURE_TTL_MS;
    this.waitMs = opts.waitMs ?? CATALOG_READ_WAIT_MS;
    this.deadlineMs = opts.deadlineMs ?? CODEX_CATALOG_HARD_DEADLINE_MS;
  }

  async read(
    userId: string,
    account: CodexCatalogAccount,
  ): Promise<CodexCatalogModel[] | undefined> {
    const key = `${userId}${account.accountId}`;
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) return entry.ok ? entry.models : undefined;
    if (entry) {
      if (!this.inflight.has(key)) void this.revalidate(key, account);
      return entry.ok ? entry.models : undefined;
    }
    const pending = this.inflight.get(key) ?? this.revalidate(key, account);
    return Promise.race([pending, sleep(this.waitMs).then(() => undefined)]);
  }

  private revalidate(
    key: string,
    account: CodexCatalogAccount,
  ): Promise<CodexCatalogModel[] | undefined> {
    // A fetch that ignores its abort signal must not pin the key in-flight
    // forever, so the tracked promise has its own hard deadline.
    const work = Promise.race([
      this.fetchModels(account),
      sleep(this.deadlineMs).then(() => undefined),
    ]);
    const tracked = work.then((models) => {
      if (this.inflight.get(key) === tracked) this.inflight.delete(key);
      this.store(
        key,
        models && models.length > 0
          ? { ok: true, models, expiresAt: this.now() + this.ttlMs }
          : { ok: false, expiresAt: this.now() + this.failureTtlMs },
      );
      return models && models.length > 0 ? models : undefined;
    });
    this.inflight.set(key, tracked);
    return tracked;
  }

  private async fetchModels(
    account: CodexCatalogAccount,
  ): Promise<CodexCatalogModel[] | undefined> {
    try {
      const accessToken = await account.accessToken();
      if (!accessToken) return undefined;
      const result = await fetchCodexCatalog(accessToken, account.accountId, this.fetchImpl);
      return result.status === "ok" ? result.models : undefined;
    } catch {
      return undefined;
    }
  }

  private store(key: string, entry: CodexCatalogCacheEntry): void {
    if (!this.entries.has(key) && this.entries.size >= MAX_CATALOG_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
  }
}

/**
 * The space's OAuth account handle for `openai-codex`, when the credential the
 * provider-level model selection would use is a ChatGPT sign-in. `modelIds` names
 * fallback model preferences whose owning credentials are also OAuth — covers a
 * space whose provider default is an API key but a model preference is ChatGPT.
 * The decrypted token stays server-side inside the `accessToken` thunk.
 */
export async function codexCatalogAuthForSpace(
  prisma: PrismaClient,
  secretStore: Pick<EncryptedSecretStore, "load" | "put">,
  scope: { userId: string; spaceId: string },
  opts: {
    modelIds?: readonly string[];
    oauth?: Pick<OAuthAuth, "refresh" | "toAuth">;
  } = {},
): Promise<CodexCatalogAccount | null> {
  for (const modelId of [undefined, ...(opts.modelIds ?? []).slice(0, 4)]) {
    const account = await codexCatalogAccountForModel(prisma, secretStore, scope, modelId, opts);
    if (account) return account;
  }
  return null;
}

async function codexCatalogAccountForModel(
  prisma: PrismaClient,
  secretStore: Pick<EncryptedSecretStore, "load" | "put">,
  scope: { userId: string; spaceId: string },
  modelId: string | undefined,
  opts: { oauth?: Pick<OAuthAuth, "refresh" | "toAuth"> },
): Promise<CodexCatalogAccount | null> {
  const credential = await findModelCredential(prisma, scope, CHATGPT_OAUTH_PROVIDER, modelId);
  if (!credential) return null;
  const secrets = await prisma.secret.findMany({
    where: { id: credential.secretId, userId: scope.userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  const secret = secrets[0];
  if (!secret) return null;
  let plaintext: string;
  try {
    plaintext = secretStore.load(secret.ciphertext, secret.id);
  } catch {
    return null;
  }
  const parsed: StoredModelSecret = parseModelSecret(plaintext);
  if (parsed.kind !== "oauth") return null;
  const accountId = codexAccountId(parsed.credential);
  if (!accountId) return null;
  // The thunk runs inside the cache's single-flight revalidation, detached from
  // any caller's abort signal — one cancelled list request must not abort a
  // refresh other readers share.
  return {
    accountId,
    accessToken: () =>
      codexAccessToken(plaintext, secretStore, prisma, secret.id, scope, opts.oauth).catch(
        () => null,
      ),
  };
}

/** Resolve a usable bearer for the catalog request; refreshes + persists near-expiry. */
async function codexAccessToken(
  plaintext: string,
  secretStore: Pick<EncryptedSecretStore, "load" | "put">,
  prisma: PrismaClient,
  secretId: string,
  scope: { userId: string; spaceId: string },
  oauth?: Pick<OAuthAuth, "refresh" | "toAuth">,
): Promise<string | null> {
  const resolved = await resolveModelAuth(plaintext, CHATGPT_OAUTH_PROVIDER, {
    oauth,
    persist: async (next) => {
      const stored = await secretStore.put(
        next,
        {
          operationId: "codex-catalog",
          traceId: "codex-catalog",
          spaceId: scope.spaceId,
          userId: scope.userId,
          signal: new AbortController().signal,
        },
        secretId,
      );
      await prisma.secret.update({
        where: { id: secretId },
        data: { ciphertext: stored.ciphertext },
      });
    },
  });
  if (resolved.secret.kind !== "oauth") return null;
  return resolved.apiKey || null;
}

/** `chatgpt-account-id` from the stored credential, else decoded from the access JWT. */
function codexAccountId(credential: OAuthCredential): string | undefined {
  const direct = credential.accountId;
  if (typeof direct === "string" && direct.trim()) return direct;
  const payload = decodeJwtPayload(credential.access);
  const claims =
    payload?.["https://api.openai.com/auth"] &&
    typeof payload["https://api.openai.com/auth"] === "object"
      ? (payload["https://api.openai.com/auth"] as Record<string, unknown>)
      : undefined;
  const accountId = claims?.chatgpt_account_id ?? payload?.chatgpt_account_id;
  return typeof accountId === "string" && accountId ? accountId : undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    return payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export type CodexCatalogSpaceAuth = {
  byProvider: Partial<Record<string, ModelCredentialAuthKind>>;
  byModel: Partial<
    Record<string, Partial<Record<string, ModelCredentialAuthKind | "disconnected">>>
  >;
};

/**
 * The live per-account catalog for this space, or `undefined` when the space has
 * no usable ChatGPT OAuth credential or the read failed — callers then keep the
 * static catalog (the conservative fallback that hides Codex Spark).
 */
export async function codexLiveCatalogForSpace(
  prisma: PrismaClient,
  secretStore: Pick<EncryptedSecretStore, "load" | "put">,
  scope: { userId: string; spaceId: string },
  auth: CodexCatalogSpaceAuth,
  catalog: CodexLiveCatalog,
): Promise<CodexCatalogModel[] | undefined> {
  const oauthModelIds = Object.keys(auth.byModel[CHATGPT_OAUTH_PROVIDER] ?? {}).filter(
    (id) => auth.byModel[CHATGPT_OAUTH_PROVIDER]?.[id] === "oauth",
  );
  if (auth.byProvider[CHATGPT_OAUTH_PROVIDER] !== "oauth" && oauthModelIds.length === 0) {
    return undefined;
  }
  const account = await codexCatalogAuthForSpace(prisma, secretStore, scope, {
    modelIds: oauthModelIds,
  });
  return account ? catalog.read(scope.userId, account) : undefined;
}

/**
 * Overlay the live catalog on the static-filtered list. Entries governed by ChatGPT
 * OAuth auth are available exactly when the backend lists them — which can restore
 * statically excluded models like Codex Spark. API-key-governed and disconnected
 * entries keep static behavior. The pi catalog supplies every field the endpoint
 * lacks; a live catalog sharing no slug with it is ignored as untrusted.
 */
export function applyCodexLiveCatalog(
  base: readonly PiCatalogEntry[],
  auth: CodexCatalogSpaceAuth,
  live: readonly CodexCatalogModel[],
): PiCatalogEntry[] {
  const liveBySlug = new Map(live.map((model) => [model.slug, model]));
  const knownSlugs = new Set(
    listPiCatalog()
      .filter((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER)
      .map((entry) => entry.id),
  );
  if (!live.some((model) => knownSlugs.has(model.slug))) return [...base];
  const baseSet = new Set(base);
  const out: PiCatalogEntry[] = [];
  const emittedCodex = new Set<string>();
  let template: PiCatalogEntry | undefined;
  for (const entry of listPiCatalog()) {
    if (entry.provider !== CHATGPT_OAUTH_PROVIDER) {
      if (baseSet.has(entry)) out.push(entry);
      continue;
    }
    template ??= entry;
    const kind =
      auth.byModel[entry.provider]?.[entry.id] ?? auth.byProvider[entry.provider] ?? "disconnected";
    const liveModel = liveBySlug.get(entry.id);
    const available = kind === "oauth" ? Boolean(liveModel) : baseSet.has(entry);
    if (!available) continue;
    emittedCodex.add(entry.id);
    out.push(liveModel ? withLiveFields(entry, liveModel) : entry);
  }
  if (template) {
    for (const model of live) {
      if (emittedCodex.has(model.slug)) continue;
      out.push(liveOnlyEntry(template, model));
    }
  }
  return out;
}

function withLiveFields(entry: PiCatalogEntry, model: CodexCatalogModel): PiCatalogEntry {
  const thinkingLevels = liveThinkingLevels(model);
  return thinkingLevels
    ? { ...entry, reasoning: true, thinkingLevels }
    : { ...entry, reasoning: entry.reasoning || model.reasoningEfforts.length > 0 };
}

function liveOnlyEntry(template: PiCatalogEntry, model: CodexCatalogModel): PiCatalogEntry {
  const thinkingLevels = liveThinkingLevels(model);
  return {
    ...template,
    id: model.slug,
    label: catalogModelLabel(model.slug),
    reasoning: model.reasoningEfforts.length > 0,
    ...(thinkingLevels ? { thinkingLevels } : {}),
  };
}

function liveThinkingLevels(model: CodexCatalogModel): ThinkingLevel[] | undefined {
  const levels = [
    ...new Set(
      model.reasoningEfforts.flatMap((effort) => {
        const parsed = ThinkingLevelSchema.safeParse(effort);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  ];
  return levels.length > 0 ? levels : undefined;
}
