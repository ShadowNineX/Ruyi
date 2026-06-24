import type { ApiRequest, ApiResponse, ITransport } from 'steam-session';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { toString as qrToString } from 'qrcode';
import {
  EAuthSessionGuardType,
  EAuthTokenPlatformType,
  LoginSession,
} from 'steam-session';

const TOKEN_WAIT_TIMEOUT_MS = 90_000;
const START_LOGIN_TIMEOUT_MS = 60_000;
const START_LOGIN_STATUS_INTERVAL_MS = 10_000;
const STEAM_WEB_API_BASE_URL = 'https://api.steampowered.com';
const MASKED_INPUT_FALLBACK_WARNING
  = 'Password input is not hidden because this terminal is not interactive.';
const STEAM_ACCOUNT_ID_PATTERN = /^[\w-]{1,64}$/;

const GET_REQUESTS = new Set(['IAuthenticationService/GetPasswordRSAPublicKey/v1']);
const STEAM_PERSONALITIES = ['ruyi', 'tails'] as const;

type LoginMode = 'qr' | 'password';
type SteamPersonality = (typeof STEAM_PERSONALITIES)[number];

interface LoginCredentials {
  accountName: string;
  password: string;
  guardCode: string | null;
}

interface SteamAccountMetadata {
  id: string;
  personality: SteamPersonality;
}

type StartCredentialsResponse = Awaited<ReturnType<LoginSession['startWithCredentials']>>;
type StartQrResponse = Awaited<ReturnType<LoginSession['startWithQR']>>;
type StartSessionResponse = StartCredentialsResponse | StartQrResponse;

interface AuthenticationWaiter {
  promise: Promise<void>;
  cancel: () => void;
}

class SteamWebApiTransport implements ITransport {
  async sendRequest(request: ApiRequest): Promise<ApiResponse> {
    const apiPath = `I${request.apiInterface}Service/${request.apiMethod}/v${request.apiVersion}`;
    const url = new URL(`${STEAM_WEB_API_BASE_URL}/${apiPath}/`);
    const isGetRequest = GET_REQUESTS.has(apiPath);
    const headers = new Headers(request.headers);
    let body: FormData | undefined;

    if (request.accessToken) {
      url.searchParams.set('access_token', request.accessToken);
    }

    if (request.requestData && request.requestData.length > 0) {
      const encodedRequest = Buffer.from(request.requestData).toString('base64');
      if (isGetRequest) {
        url.searchParams.set('input_protobuf_encoded', encodedRequest);
      } else {
        body = new FormData();
        body.set('input_protobuf_encoded', encodedRequest);
      }
    }

    const response = await fetch(url, {
      method: isGetRequest ? 'GET' : 'POST',
      headers,
      body,
    });

    const resultHeader = response.headers.get('x-eresult');
    const errorMessage = response.headers.get('x-error_message') ?? undefined;
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

function hasArg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function getArgValue(name: string): string | null {
  const prefix = `--${name}=`;
  const exact = `--${name}`;

  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index] ?? '';
    if (arg.startsWith(prefix)) { return arg.slice(prefix.length).trim(); }
    if (arg === exact) {
      const next = process.argv[index + 1];
      return next && !next.startsWith('--') ? next.trim() : '';
    }
  }

  return null;
}

function getLoginMode(): LoginMode {
  const mode = getArgValue('mode') ?? 'qr';
  if (mode === 'qr' || mode === 'password') { return mode; }
  throw new Error('Unsupported mode. Use "--mode=qr" or "--mode=password".');
}

function isInteractiveTerminal(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

async function readLine(prompt: string): Promise<string> {
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    return (await reader.question(prompt)).trim();
  } finally {
    reader.close();
  }
}

function validateAccountId(value: string): string {
  const trimmed = value.trim();
  if (!STEAM_ACCOUNT_ID_PATTERN.test(trimmed)) {
    throw new Error(
      'Steam account id must be alphanumeric with underscores/hyphens, max 64 chars',
    );
  }
  return trimmed;
}

function parsePersonality(value: string): SteamPersonality {
  const normalized = value.trim().toLowerCase();
  if (STEAM_PERSONALITIES.includes(normalized as SteamPersonality)) {
    return normalized as SteamPersonality;
  }
  throw new Error(`Unsupported personality "${value}". Use ruyi or tails.`);
}

function defaultAccountId(personality: SteamPersonality): string {
  return personality;
}

function printUsage(): void {
  stdout.write(`Steam refresh token helper

Usage:
  bun run steam:token
  bun run steam:token -- --mode=password
  bun run steam:token -- --personality=tails --id=tails

Options:
  --mode=qr|password       QR login is the default.
  --id=ruyi                Short internal account id for STEAM_ACCOUNTS.
                           This is not your Steam username or SteamID64.
                           Use "ruyi" for the main bot, "tails" for Tails.
  --personality=ruyi|tails Persona this Steam account should use.
  --account=name           Steam account name for password mode.
  --password=value         Steam password for password mode.
  --guard-code=value       Steam Guard code for password mode.

After login, the script prints the STEAM_ACCOUNTS JSON for .env.
`);
}

function printSteamAccountPromptHelp(steamId64: string): void {
  stdout.write(`
Steam authenticated as ${steamId64}.

Now choose how Ruyi should store this Steam bot account:
- Personality controls how this Steam account talks.
  ruyi  = normal Ruyi personality
  tails = Tails personality
- Account id is a short internal label used in STEAM_ACCOUNTS and tool calls.
  It is NOT your Steam username and NOT your SteamID64.
  Good ids: ruyi, tails

Press Enter to accept the value in brackets.

`);
}

async function readOptionalArg(
  name: string,
  prompt: string,
): Promise<string | null> {
  const argValue = getArgValue(name);
  if (argValue !== null) { return argValue; }
  if (!isInteractiveTerminal()) { return null; }
  const answer = await readLine(prompt);
  return answer || null;
}

async function getSteamAccountMetadata(
  steamId64: string,
): Promise<SteamAccountMetadata> {
  printSteamAccountPromptHelp(steamId64);

  const personalityInput = await readOptionalArg(
    'personality',
    'Personality for this Steam account (ruyi = Ruyi, tails = Tails) [ruyi]: ',
  );
  const personality = personalityInput
    ? parsePersonality(personalityInput)
    : 'ruyi';
  const fallbackId = defaultAccountId(personality);
  const idInput = await readOptionalArg(
    'id',
    `Internal account id for STEAM_ACCOUNTS [${fallbackId}]: `,
  );

  return {
    id: validateAccountId(idInput ?? fallbackId),
    personality,
  };
}

async function readHiddenLine(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) {
    stdout.write(`${MASKED_INPUT_FALLBACK_WARNING}\n`);
    return readLine(prompt);
  }

  return new Promise<string>((resolve, reject) => {
    const wasRaw = stdin.isRaw;
    let value = '';

    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write('\n');
    };

    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Cancelled by user'));
          return;
        }

        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }

        if (char === '\u007F' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }

        value += char;
      }
    };

    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function getCredentials(): Promise<LoginCredentials> {
  const accountName
    = getArgValue('account') ?? (await readLine('Steam account name: '));
  if (!accountName) {
    throw new Error('Steam account name is required');
  }

  const password
    = getArgValue('password') ?? (await readHiddenLine('Steam password: '));
  if (!password) {
    throw new Error('Steam password is required');
  }

  return { accountName, password, guardCode: getArgValue('guard-code') };
}

function getJwtExpiry(token: string): Date | null {
  const payloadSegment = token.split('.')[1];
  if (!payloadSegment) { return null; }

  try {
    const payload: unknown = JSON.parse(
      Buffer.from(payloadSegment, 'base64url').toString('utf8'),
    );
    if (payload === null || typeof payload !== 'object') { return null; }

    const exp = (payload as { exp?: unknown }).exp;
    return typeof exp === 'number' ? new Date(exp * 1000) : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printStatus(`Could not parse refresh token expiry: ${message}`);
    return null;
  }
}

function printToken(
  refreshToken: string,
  steamId64: string,
  metadata: SteamAccountMetadata,
): void {
  const expiresAt = getJwtExpiry(refreshToken);
  const account = {
    id: metadata.id,
    personality: metadata.personality,
    refreshToken,
    botSteamId64: steamId64,
  };

  stdout.write('\nSteam refresh token created.\n\n');
  stdout.write('Account object:\n\n');
  stdout.write(`${JSON.stringify(account)}\n\n`);
  stdout.write('If this is your first Steam account, put this in .env:\n\n');
  stdout.write(`STEAM_ACCOUNTS=${JSON.stringify([account])}\n`);
  stdout.write(
    '\nIf STEAM_ACCOUNTS already exists, add the account object inside the existing JSON array instead of replacing the other accounts.\n',
  );
  stdout.write('\nSet STEAM_OWNER_STEAM_ID64 once for the shared owner profile.\n');

  if (expiresAt) {
    stdout.write(`\nToken expiry: ${expiresAt.toISOString()}\n`);
  }

  stdout.write(
    '\nKeep this token private. It can log in as this Steam account.\n',
  );
}

function printStatus(message: string): void {
  stdout.write(`[steam-token] ${message}\n`);
}

function getElapsedSeconds(startedAt: number): number {
  return Math.round((Date.now() - startedAt) / 1000);
}

async function startWithQr(session: LoginSession): Promise<StartQrResponse> {
  printStatus('Creating Steam QR login challenge.');
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
              'Timed out waiting for Steam to answer the login request. Steam may be slow, blocked, or unreachable from this terminal.',
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
      return 'email code';
    case EAuthSessionGuardType.DeviceCode:
      return 'Steam mobile app code';
    case EAuthSessionGuardType.DeviceConfirmation:
      return 'Steam mobile app approval';
    case EAuthSessionGuardType.EmailConfirmation:
      return 'email approval';
    default:
      return EAuthSessionGuardType[type] ?? `guard type ${type}`;
  }
}

function hasGuardAction(
  response: StartSessionResponse,
  type: EAuthSessionGuardType,
): boolean {
  return response.validActions?.some(action => action.type === type) ?? false;
}

function formatGuardActions(response: StartSessionResponse): string {
  const actions = response.validActions ?? [];
  if (actions.length === 0) { return 'none'; }

  return actions
    .map((action) => {
      const label = formatGuardAction(action.type);
      return action.detail ? `${label} (${action.detail})` : label;
    })
    .join(', ');
}

async function printQrLogin(response: StartQrResponse): Promise<void> {
  if (!response.qrChallengeUrl) {
    throw new Error('Steam did not return a QR challenge URL');
  }

  const qrCode = await qrToString(response.qrChallengeUrl, {
    type: 'terminal',
    small: true,
    margin: 1,
  });
  stdout.write('\n');
  stdout.write(qrCode);
  stdout.write('\n');
  stdout.write('Scan this QR code with the Steam mobile app.\n');
  stdout.write(`Fallback URL: ${response.qrChallengeUrl}\n\n`);
}

function createAuthenticationWaiter(session: LoginSession): AuthenticationWaiter {
  let cleanup = (): void => {};
  let resolveWait: (() => void) | null = null;

  const promise = new Promise<void>((resolve, reject) => {
    resolveWait = resolve;
    cleanup = (): void => {
      session.off('authenticated', onAuthenticated);
      session.off('timeout', onTimeout);
      session.off('error', onError);
    };

    const onAuthenticated = (): void => {
      cleanup();
      resolve();
    };

    const onTimeout = (): void => {
      cleanup();
      reject(new Error('Timed out waiting for Steam authentication approval'));
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    session.once('authenticated', onAuthenticated);
    session.once('timeout', onTimeout);
    session.once('error', onError);
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
    printStatus('Submitting Steam Guard code from --guard-code.');
    await session.submitSteamGuardCode(suppliedCode);
    return;
  }

  const canApproveExternally
    = hasGuardAction(response, EAuthSessionGuardType.DeviceConfirmation)
      || hasGuardAction(response, EAuthSessionGuardType.EmailConfirmation);
  if (canApproveExternally) { return; }

  const needsCode
    = hasGuardAction(response, EAuthSessionGuardType.EmailCode)
      || hasGuardAction(response, EAuthSessionGuardType.DeviceCode);
  if (!needsCode) { return; }

  const code = await readLine('Enter Steam Guard code: ');
  if (!code) {
    throw new Error('Steam Guard code is required for this login');
  }

  printStatus('Submitting Steam Guard code.');
  await session.submitSteamGuardCode(code);
}

async function main(): Promise<void> {
  if (hasArg('help') || process.argv.includes('-h')) {
    printUsage();
    return;
  }

  printStatus('Starting one-time Steam refresh token login.');
  const mode = getLoginMode();
  let guardCode = getArgValue('guard-code');
  printStatus(`Login mode: ${mode}.`);

  const session = new LoginSession(EAuthTokenPlatformType.SteamClient, {
    machineFriendlyName: 'Ruyi refresh token helper',
    transport: new SteamWebApiTransport(),
  });
  session.loginTimeout = TOKEN_WAIT_TIMEOUT_MS;

  session.once('polling', () => {
    printStatus('Waiting for Steam authentication to complete.');
  });
  session.once('remoteInteraction', () => {
    printStatus('Steam mobile approval prompt was opened.');
  });
  session.once('steamGuardMachineToken', () => {
    printStatus('Steam issued a machine token for this device.');
  });
  session.on('debug', (message: unknown) => {
    if (typeof message !== 'string') { return; }
    printStatus(`Steam session: ${message}`);
  });

  const authentication = createAuthenticationWaiter(session);
  let response: StartSessionResponse;

  if (mode === 'qr') {
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
    printStatus('Submitting login to Steam.');
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
      printStatus('Approve this login in the Steam mobile app.');
    }
    if (hasGuardAction(response, EAuthSessionGuardType.EmailConfirmation)) {
      printStatus('Approve the Steam login confirmation email.');
    }
    await submitCodeIfNeeded(session, response, guardCode);
  } else {
    printStatus('No Steam Guard action is required.');
  }

  await authentication.promise;
  printStatus('Steam authentication accepted.');

  if (!session.refreshToken || !session.steamID) {
    throw new Error('Steam authenticated but did not return a refresh token');
  }

  const steamId64 = session.steamID.getSteamID64();
  const metadata = await getSteamAccountMetadata(steamId64);
  printToken(session.refreshToken, steamId64, metadata);
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Steam refresh token login failed: ${message}`);
  process.exitCode = 1;
}
