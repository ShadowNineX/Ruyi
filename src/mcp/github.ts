import { SmitheryMCPServer } from "./smithery";

/**
 * GitHub MCP server configuration.
 * Uses Smithery's hosted GitHub MCP server.
 *
 * Authorize it from Discord with `/smithery`.
 */
export class GitHubMCPServer extends SmitheryMCPServer {
  readonly name = "github";
  readonly toolPrefix = "github_";
  protected readonly slug = "github";
}

export const githubMCP = new GitHubMCPServer();
