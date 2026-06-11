import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  SMITHERY_CLIENT_METADATA,
  SMITHERY_REDIRECT_URL,
} from "./constants";

/**
 * OAuth provider that captures the authorization URL for the manual Discord flow.
 */
export class SmitheryOAuthProvider implements OAuthClientProvider {
  private tokensValue?: OAuthTokens;
  private clientInfo?: OAuthClientInformation;
  private verifier?: string;

  capturedAuthUrl?: URL;

  get redirectUrl(): string {
    return SMITHERY_REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return SMITHERY_CLIENT_METADATA;
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.clientInfo;
  }

  async saveClientInformation(info: OAuthClientInformation): Promise<void> {
    this.clientInfo = info;
  }

  tokens(): OAuthTokens | undefined {
    return this.tokensValue;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.tokensValue = tokens;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this.capturedAuthUrl = url;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    this.verifier = verifier;
  }

  async codeVerifier(): Promise<string> {
    if (!this.verifier) throw new Error("No code verifier stored");
    return this.verifier;
  }

  getAccessToken(): string | undefined {
    return this.tokensValue?.access_token;
  }

  getRefreshToken(): string | undefined {
    return this.tokensValue?.refresh_token;
  }

  getExpiresIn(): number | undefined {
    return this.tokensValue?.expires_in;
  }
}
