import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { toString as qrToString } from "qrcode";
import {
  EAuthSessionGuardType,
  EAuthTokenPlatformType,
  LoginSession,
} from "steam-session";
import type { ApiRequest, ApiResponse, ITransport } from "steam-session";

const TOKEN_WAIT_TIMEOUT_MS = 90_000;
const START_LOGIN_TIMEOUT_MS = 60_000;
const START_LOGIN_STATUS_INTERVAL_MS = 10_000;
const STEAM_WEB_API_BASE_URL = "https://api.steampowered.com";
const MASKED_INPUT_FALLBACK_WARNING =
  "Password input is not hidden because this terminal is not interactive.";

const GET_REQUESTS = new Set(["IAuthenticationService/GetPasswordRSAPublicKey/v1"]);

type LoginMode = "qr" | "password";

interface LoginCredentials {
  accountName: string;
  password: string;
  guardCode: string | null;
}

type StartCredentialsResponse = Awaited<ReturnType<LoginSession["startWithCredentials"]>>;
type StartQrResponse = Awaited<ReturnType<LoginSession["startWithQR"]>>;
type StartSessionResponse = StartCredentialsResponse | StartQrResponse;

interface AuthenticationWaiter {
  promise: Promise<void>;
  cancel(): void;
}

class SteamWebApiTransport implements ITransport {
  async sendRequest(request: ApiRequest): Promise<ApiResponse> {
    const apiPath = `I${request.apiInterface}Service/${request.apiMethod}/v${request.apiVersion}`;
    const url = new URL(`${STEAM_WEB_API_BASE_URL}/${apiPath}/`);
    const isGetRequest = GET_REQUESTS.has(apiPath);
    const headers = new Headers(request.headers);
    let body: FormData | undefined;

    if (request.accessToken) {
      url.searchParams.set("access_token", request.accessToken);
    }

    if (request.requestData && request.requestData.length > 0) {
      const encodedRequest = Buffer.from(request.requestData).toString("base64");
      if (isGetRequest) {
        url.searchParams.set("input_protobuf_encoded", encodedRequest);
      } else {
        body = new FormData();
        body.set("input_protobuf_encoded", encodedRequest);
      }
    }

    const response = await fetch(url, {
      method: isGetRequest ? "GET" : "POST",
      headers,
      body,
    });

    const resultHeader = response.headers.get("x-eresult");
    const errorMessage = response.headers.get("x-error_message") ?? undefined;
    if (!response.ok) {
      throw new Error(`Steam Web API returned HTTP ${response.status}`);
    }

    return {
      result: resultHeader ? Number(resultHeader) : undefined,
      errorMessage,
      responseData: Buffer.from(await response.arrayBuffer()),
    };
  }

  close(): void {
    // No persistent resources are held by fetch.
  }
}

function getArgValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() : null;
}

function getLoginMode(): LoginMode {
  const mode = getArgValue("mode") ?? "qr";
  if (mode === "qr" || mode === "password") return mode;
  throw new Error('Unsupported mode. Use "--mode=qr" or "--mode=password".');
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

function getElapsedSeconds(startedAt: number): number {
  return Math.round((Date.now() - startedAt) / 1000);
}

async function startWithQr(session: LoginSession): Promise<StartQrResponse> {
  printStatus("Creating Steam QR login challenge.");
  return session.startWithQR();
}

async function startWithCredentials(
  session: LoginSession,
  credentials: LoginCredentials,
): Promise<StartCredentialsResponse> {
  const startedAt = Date.now();
  let statusTick: ReturnType<typeof setInterval> | null = setInterval(() => {
    printStatus(
      `Still waiting for Steam to answer the login request (${getElapsedSeconds(startedAt)}s).`,
    );
  }, START_LOGIN_STATUS_INTERVAL_MS);

  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      session.startWithCredentials({
        accountName: credentials.accountName,
        password: credentials.password,
        steamGuardCode: credentials.guardCode ?? undefined,
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              "Timed out waiting for Steam to answer the login request. Steam may be slow, blocked, or unreachable from this terminal.",
            ),
          );
        }, START_LOGIN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (statusTick) {
      clearInterval(statusTick);
      statusTick = null;
    }
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  }
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
  response: StartSessionResponse,
  type: EAuthSessionGuardType,
): boolean {
  return response.validActions?.some((action) => action.type === type) ?? false;
}

function formatGuardActions(response: StartSessionResponse): string {
  const actions = response.validActions ?? [];
  if (actions.length === 0) return "none";

  return actions
    .map((action) => {
      const label = formatGuardAction(action.type);
      return action.detail ? `${label} (${action.detail})` : label;
    })
    .join(", ");
}

async function printQrLogin(response: StartQrResponse): Promise<void> {
  if (!response.qrChallengeUrl) {
    throw new Error("Steam did not return a QR challenge URL");
  }

  const qrCode = await qrToString(response.qrChallengeUrl, {
    type: "terminal",
    small: true,
    margin: 1,
  });
  stdout.write("\n");
  stdout.write(qrCode);
  stdout.write("\n");
  stdout.write("Scan this QR code with the Steam mobile app.\n");
  stdout.write(`Fallback URL: ${response.qrChallengeUrl}\n\n`);
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
  response: StartSessionResponse,
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
  const mode = getLoginMode();
  let guardCode = getArgValue("guard-code");
  printStatus(`Login mode: ${mode}.`);

  const session = new LoginSession(EAuthTokenPlatformType.SteamClient, {
    machineFriendlyName: "Ruyi refresh token helper",
    transport: new SteamWebApiTransport(),
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
  session.on("debug", (message: unknown) => {
    if (typeof message !== "string") return;
    printStatus(`Steam session: ${message}`);
  });

  const authentication = createAuthenticationWaiter(session);
  let response: StartSessionResponse;

  if (mode === "qr") {
    try {
      response = await startWithQr(session);
      await printQrLogin(response);
    } catch (error: unknown) {
      authentication.cancel();
      throw error;
    }
  } else {
    const credentials = await getCredentials();
    guardCode = credentials.guardCode;
    printStatus(`Using Steam account "${credentials.accountName}".`);
    printStatus("Submitting login to Steam.");
    try {
      response = await startWithCredentials(session, credentials);
    } catch (error: unknown) {
      authentication.cancel();
      throw error;
    }
  }

  if (response.actionRequired) {
    printStatus(`Steam Guard options: ${formatGuardActions(response)}.`);
    if (hasGuardAction(response, EAuthSessionGuardType.DeviceConfirmation)) {
      printStatus("Approve this login in the Steam mobile app.");
    }
    if (hasGuardAction(response, EAuthSessionGuardType.EmailConfirmation)) {
      printStatus("Approve the Steam login confirmation email.");
    }
    await submitCodeIfNeeded(session, response, guardCode);
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
