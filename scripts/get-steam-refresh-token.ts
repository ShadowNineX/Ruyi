import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  EAuthSessionGuardType,
  EAuthTokenPlatformType,
  LoginSession,
} from "steam-session";

const TOKEN_WAIT_TIMEOUT_MS = 90_000;
const MASKED_INPUT_FALLBACK_WARNING =
  "Password input is not hidden because this terminal is not interactive.";

interface LoginCredentials {
  accountName: string;
  password: string;
  guardCode: string | null;
}

type StartCredentialsResponse = Awaited<
  ReturnType<LoginSession["startWithCredentials"]>
>;

interface AuthenticationWaiter {
  promise: Promise<void>;
  cancel(): void;
}

function getArgValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() : null;
}

async function readLine(prompt: string): Promise<string> {
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    return (await reader.question(prompt)).trim();
  } finally {
    reader.close();
  }
}

async function readHiddenLine(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) {
    stdout.write(`${MASKED_INPUT_FALLBACK_WARNING}\n`);
    return readLine(prompt);
  }

  return new Promise<string>((resolve, reject) => {
    const wasRaw = stdin.isRaw;
    let value = "";

    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write("\n");
    };

    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Cancelled by user"));
          return;
        }

        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }

        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }

        value += char;
      }
    };

    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function getCredentials(): Promise<LoginCredentials> {
  const accountName =
    getArgValue("account") ?? (await readLine("Steam account name: "));
  if (!accountName) {
    throw new Error("Steam account name is required");
  }

  const password =
    getArgValue("password") ?? (await readHiddenLine("Steam password: "));
  if (!password) {
    throw new Error("Steam password is required");
  }

  return { accountName, password, guardCode: getArgValue("guard-code") };
}

function getJwtExpiry(token: string): Date | null {
  const payloadSegment = token.split(".")[1];
  if (!payloadSegment) return null;

  try {
    const payload: unknown = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8"),
    );
    if (payload === null || typeof payload !== "object") return null;

    const exp = (payload as { exp?: unknown }).exp;
    return typeof exp === "number" ? new Date(exp * 1000) : null;
  } catch {
    return null;
  }
}

function printToken(refreshToken: string, steamId64: string): void {
  const expiresAt = getJwtExpiry(refreshToken);

  stdout.write("\nSteam refresh token created.\n\n");
  stdout.write("Add these to .env:\n\n");
  stdout.write(`STEAM_REFRESH_TOKEN=${refreshToken}\n`);
  stdout.write(`STEAM_BOT_STEAM_ID64=${steamId64}\n`);

  if (expiresAt) {
    stdout.write(`\nToken expiry: ${expiresAt.toISOString()}\n`);
  }

  stdout.write(
    "\nKeep this token private. It can log in as this Steam account.\n",
  );
}

function printStatus(message: string): void {
  stdout.write(`[steam-token] ${message}\n`);
}

function formatGuardAction(type: EAuthSessionGuardType): string {
  switch (type) {
    case EAuthSessionGuardType.EmailCode:
      return "email code";
    case EAuthSessionGuardType.DeviceCode:
      return "Steam mobile app code";
    case EAuthSessionGuardType.DeviceConfirmation:
      return "Steam mobile app approval";
    case EAuthSessionGuardType.EmailConfirmation:
      return "email approval";
    default:
      return EAuthSessionGuardType[type] ?? `guard type ${type}`;
  }
}

function hasGuardAction(
  response: StartCredentialsResponse,
  type: EAuthSessionGuardType,
): boolean {
  return response.validActions?.some((action) => action.type === type) ?? false;
}

function formatGuardActions(response: StartCredentialsResponse): string {
  const actions = response.validActions ?? [];
  if (actions.length === 0) return "none";

  return actions
    .map((action) => {
      const label = formatGuardAction(action.type);
      return action.detail ? `${label} (${action.detail})` : label;
    })
    .join(", ");
}

function createAuthenticationWaiter(session: LoginSession): AuthenticationWaiter {
  let cleanup = (): void => {};
  let resolveWait: (() => void) | null = null;

  const promise = new Promise<void>((resolve, reject) => {
    resolveWait = resolve;
    cleanup = (): void => {
      session.off("authenticated", onAuthenticated);
      session.off("timeout", onTimeout);
      session.off("error", onError);
    };

    const onAuthenticated = (): void => {
      cleanup();
      resolve();
    };

    const onTimeout = (): void => {
      cleanup();
      reject(new Error("Timed out waiting for Steam authentication approval"));
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    session.once("authenticated", onAuthenticated);
    session.once("timeout", onTimeout);
    session.once("error", onError);
  });

  return {
    promise,
    cancel() {
      cleanup();
      resolveWait?.();
    },
  };
}

async function submitCodeIfNeeded(
  session: LoginSession,
  response: StartCredentialsResponse,
  suppliedCode: string | null,
): Promise<void> {
  if (suppliedCode) {
    printStatus("Submitting Steam Guard code from --guard-code.");
    await session.submitSteamGuardCode(suppliedCode);
    return;
  }

  const canApproveExternally =
    hasGuardAction(response, EAuthSessionGuardType.DeviceConfirmation) ||
    hasGuardAction(response, EAuthSessionGuardType.EmailConfirmation);
  if (canApproveExternally) return;

  const needsCode =
    hasGuardAction(response, EAuthSessionGuardType.EmailCode) ||
    hasGuardAction(response, EAuthSessionGuardType.DeviceCode);
  if (!needsCode) return;

  const code = await readLine("Enter Steam Guard code: ");
  if (!code) {
    throw new Error("Steam Guard code is required for this login");
  }

  printStatus("Submitting Steam Guard code.");
  await session.submitSteamGuardCode(code);
}

async function main(): Promise<void> {
  printStatus("Starting one-time Steam refresh token login.");
  const credentials = await getCredentials();
  printStatus(`Using Steam account "${credentials.accountName}".`);

  const session = new LoginSession(EAuthTokenPlatformType.SteamClient, {
    machineFriendlyName: "Ruyi refresh token helper",
  });
  session.loginTimeout = TOKEN_WAIT_TIMEOUT_MS;

  session.once("polling", () => {
    printStatus("Waiting for Steam authentication to complete.");
  });
  session.once("remoteInteraction", () => {
    printStatus("Steam mobile approval prompt was opened.");
  });
  session.once("steamGuardMachineToken", () => {
    printStatus("Steam issued a machine token for this device.");
  });

  const authentication = createAuthenticationWaiter(session);
  printStatus("Submitting login to Steam.");
  let response: StartCredentialsResponse;
  try {
    response = await session.startWithCredentials({
      accountName: credentials.accountName,
      password: credentials.password,
      steamGuardCode: credentials.guardCode ?? undefined,
    });
  } catch (error: unknown) {
    authentication.cancel();
    throw error;
  }

  if (response.actionRequired) {
    printStatus(`Steam Guard options: ${formatGuardActions(response)}.`);
    if (hasGuardAction(response, EAuthSessionGuardType.DeviceConfirmation)) {
      printStatus("Approve this login in the Steam mobile app.");
    }
    if (hasGuardAction(response, EAuthSessionGuardType.EmailConfirmation)) {
      printStatus("Approve the Steam login confirmation email.");
    }
    await submitCodeIfNeeded(session, response, credentials.guardCode);
  } else {
    printStatus("No Steam Guard action is required.");
  }

  await authentication.promise;
  printStatus("Steam authentication accepted.");

  if (!session.refreshToken || !session.steamID) {
    throw new Error("Steam authenticated but did not return a refresh token");
  }

  printToken(session.refreshToken, session.steamID.getSteamID64());
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Steam refresh token login failed: ${message}`);
  process.exitCode = 1;
}
