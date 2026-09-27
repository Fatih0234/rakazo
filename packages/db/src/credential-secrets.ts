import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

type CredentialSecretClient = Pick<
  PrismaClient,
  "secret" | "userModelCredential" | "userVoiceCredential"
>;

export async function deleteUnreferencedCredentialSecret(
  prisma: CredentialSecretClient,
  input: {
    credentialKind: "model" | "voice";
    credentialId: string;
    secretId: string;
  },
): Promise<void> {
  const [modelReferences, voiceReferences] = await Promise.all([
    prisma.userModelCredential.count({
      where: {
        secretId: input.secretId,
        ...(input.credentialKind === "model" ? { id: { not: input.credentialId } } : {}),
      },
    }),
    prisma.userVoiceCredential.count({
      where: {
        secretId: input.secretId,
        ...(input.credentialKind === "voice" ? { id: { not: input.credentialId } } : {}),
      },
    }),
  ]);
  if (modelReferences + voiceReferences === 0) {
    await prisma.secret.deleteMany({ where: { id: input.secretId } });
  }
}

/**
 * Drop a model credential whose stored OAuth material is dead, along with the
 * secret row nothing else references. The provider then reports `disconnected`
 * through the existing catalog auth machinery.
 * `secretId` guards against a reconnect race: if the row already moved to a new
 * secret, leave it alone — the retired material is gone either way.
 */
export async function retireModelCredential(
  prisma: Pick<PrismaClient, "$transaction">,
  input: { userId: string; credentialId: string; secretId?: string },
): Promise<void> {
  if (!input.credentialId) return;
  await withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const credential = await tx.userModelCredential.findFirst({
          where: { id: input.credentialId, userId: input.userId },
        });
        if (!credential || (input.secretId && credential.secretId !== input.secretId)) return;
        await tx.spaceModelPreference.deleteMany({
          where: { userId: input.userId, credentialId: credential.id },
        });
        await tx.userModelCredential.delete({ where: { id: credential.id } });
        await deleteUnreferencedCredentialSecret(tx, {
          credentialKind: "model",
          credentialId: credential.id,
          secretId: credential.secretId,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
