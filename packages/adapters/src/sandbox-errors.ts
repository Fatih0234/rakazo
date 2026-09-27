// How a managed provider words a sandbox that no longer exists. It does not always say "not found":
// an expired sandbox can surface as a timeout error about the *sandbox* timeout (502 / Unavailable
// from the provider runtime), which used to read as a live sandbox and left every later call
// throwing forever.
const SANDBOX_GONE_MESSAGE =
  /probably not running anymore|likely due to sandbox timeout|killed or reached its end of life|sandbox [^:]{0,60}not found|sandbox [^:]{0,60}does not exist/i;
// The same words from a live sandbox: a missing binary or a missing file inside it.
const SHELL_MISSING_TARGET = /command not found|no such file|^path .* not found/i;
/** Only provider-specific evidence of sandbox loss permits automatic replacement. */
export function isSandboxGoneError(error: unknown): boolean {
  const message = errorMessage(error);
  if (SHELL_MISSING_TARGET.test(message)) return false;
  if (SANDBOX_GONE_MESSAGE.test(message)) return true;
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current.name === "SandboxNotFoundError") return true;
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
