import type { OAuthCredential } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it, vi } from "vitest";
import { PiRuntimeCredentialStore } from "./pi-credentials.js";
import { OAUTH_ACCOUNT_CHANGED_ERROR } from "./pi-oauth.js";

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60 * 60_000,
    ...overrides,
  };
}

describe("PiRuntimeCredentialStore", () => {
  it("does not configure openai-codex without a stored OAuth credential", async () => {
    expect(await builtinModels().getAuth("openai-codex")).toBeUndefined();
  });

  it("bridges an encrypted OAuth credential into the OAuth-only Codex provider", async () => {
    const store = new PiRuntimeCredentialStore("openai-codex", credential());
    const models = builtinModels({ credentials: store });

    const auth = await models.getAuth("openai-codex");

    expect(auth?.auth.apiKey).toBe("access-token");
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
  });

  it("serializes refresh publication without exposing credential values in metadata", async () => {
    let persisted: OAuthCredential | undefined;
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ access: "old-access" }),
      async (next) => {
        persisted = next;
      },
    );

    await store.modify("openai-codex", async () => credential({ access: "new-access" }));

    expect(persisted?.access).toBe("new-access");
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
  });

  it("retires once when a mid-run refresh is terminally rejected", async () => {
    const retire = vi.fn(async () => {});
    const store = new PiRuntimeCredentialStore("openai-codex", credential(), undefined, retire);
    const failure = new Error("OAuth refresh failed for openai-codex", {
      cause: new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}'),
    });

    await expect(
      store.modify("openai-codex", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(retire).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledWith(
      "terminal-refresh-failure",
      "invalid_grant",
      // The credential state the failed refresh was attempted on.
      expect.objectContaining({ refresh: "refresh-token" }),
    );
    // The failed refresh must not clear the in-memory credential itself.
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
  });

  it("settles retirement before the refresh error surfaces", async () => {
    let releaseRetire!: () => void;
    const retireGate = new Promise<void>((resolve) => {
      releaseRetire = resolve;
    });
    const retire = vi.fn(() => retireGate);
    const store = new PiRuntimeCredentialStore("openai-codex", credential(), undefined, retire);
    const failure = new Error("OAuth refresh failed for openai-codex", {
      cause: new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}'),
    });

    let settled = false;
    const modification = store
      .modify("openai-codex", async () => {
        throw failure;
      })
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
    // The delete must commit before the failure can be observed.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseRetire();
    await modification;
    expect(settled).toBe(true);
  });

  it("does not retire on transient mid-run refresh failures", async () => {
    const retire = vi.fn(async () => {});
    const store = new PiRuntimeCredentialStore("openai-codex", credential(), undefined, retire);

    for (const failure of [
      new Error("OAuth refresh failed for openai-codex", {
        cause: new Error("OpenAI Codex token refresh failed (500): upstream"),
      }),
      new Error("OpenAI Codex token refresh error: socket hang up"),
    ]) {
      await expect(
        store.modify("openai-codex", async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
    }
    expect(retire).not.toHaveBeenCalled();
  });

  it("surfaces the refresh error when the awaited retirement fails", async () => {
    const retire = vi.fn(async () => {
      throw new Error("database gone");
    });
    const store = new PiRuntimeCredentialStore("openai-codex", credential(), undefined, retire);
    const failure = new Error('refresh failed (400): {"error":"refresh_token_reused"}');

    await expect(
      store.modify("openai-codex", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(retire).toHaveBeenCalledWith(
      "terminal-refresh-failure",
      "refresh_token_reused",
      expect.objectContaining({ refresh: "refresh-token" }),
    );
  });

  it("persists a mid-run refresh that returns the same account", async () => {
    const retire = vi.fn(async () => {});
    let persisted: OAuthCredential | undefined;
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ access: "old-access", accountId: "acct-a" }),
      async (next) => {
        persisted = next;
      },
      retire,
    );

    await store.modify("openai-codex", async () =>
      credential({ access: "new-access", accountId: "acct-a" }),
    );

    expect(persisted?.access).toBe("new-access");
    expect(retire).not.toHaveBeenCalled();
  });

  it("retires and fails a mid-run refresh that returns a different account", async () => {
    const retire = vi.fn(async () => {});
    const persist = vi.fn(async () => {});
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ accountId: "acct-a" }),
      persist,
      retire,
    );

    await expect(
      store.modify("openai-codex", async () =>
        credential({ access: "new-access", accountId: "acct-b" }),
      ),
    ).rejects.toThrow(OAUTH_ACCOUNT_CHANGED_ERROR);

    expect(retire).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledWith(
      "account-changed",
      "stored account acct-a, refreshed account acct-b",
    );
    // The account-B token is never persisted or adopted in memory.
    expect(persist).not.toHaveBeenCalled();
    expect(await store.read("openai-codex")).toMatchObject({ access: "access-token" });
  });

  it("still fails the refresh when scheduled account-change retirement fails", async () => {
    const retire = vi.fn(async () => {
      throw new Error("database gone");
    });
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ accountId: "acct-a" }),
      undefined,
      retire,
    );

    await expect(
      store.modify("openai-codex", async () => credential({ accountId: "acct-b" })),
    ).rejects.toThrow(OAUTH_ACCOUNT_CHANGED_ERROR);
    expect(retire).toHaveBeenCalledWith(
      "account-changed",
      "stored account acct-a, refreshed account acct-b",
    );
    // Let the detached retirement settle; its failure is logged, not rethrown.
    await Promise.resolve();
    await Promise.resolve();
  });

  it("tolerates a missing account id on either side of a mid-run refresh", async () => {
    const retire = vi.fn(async () => {});
    const persisted: OAuthCredential[] = [];
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ access: "old-access" }),
      async (next) => {
        persisted.push(next);
      },
      retire,
    );

    // Stored side has no account id: no comparison, no retirement.
    await store.modify("openai-codex", async () =>
      credential({ access: "new-access", accountId: "acct-b" }),
    );
    // Refreshed side has no account id either.
    await store.modify("openai-codex", async () => credential({ access: "newer-access" }));

    expect(persisted.map((entry) => entry.access)).toEqual(["new-access", "newer-access"]);
    expect(retire).not.toHaveBeenCalled();
  });
});
