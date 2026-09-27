import { ManagedSandboxEmulator } from "./managed-emulator.js";

/** Managed-provider emulator configured with Daytona identity. */
export class DaytonaSandboxEmulator extends ManagedSandboxEmulator {
  constructor() {
    super({ id: "daytona-emulator", kind: "daytona" });
  }
}
