import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { botLogger } from "../logger";
import { saveSmitheryTokens, type SmitheryServerId } from "../db/models";

// Store pending OAuth flows (userId -> provider state)
const pendingFlows = new Map<
  string,
  {
    provider: SmitheryOAuthProvider;
    serverUrl: string;
    serverId: SmitheryServerId;
    authUrl?: URL;
  }
>();

// Smithery OAuth configuration. The actual MCP connection uses the OpenAI
// Agents SDK; this only handles the user-facing authorization dance.
const REDIRECT_URL = "https://smithery.ai/oauth/callback";
const CLIENT_METADATA: OAuthClientMetadata = {
  client_name: "Ruyi Discord Bot",
  redirect_uris: [REDIRECT_URL],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  scope: "mcp:read mcp:write",
};

// Server info for display
const SERVERS: Record<SmitheryServerId, { name: string; emoji: string }> = {
  brave: { name: "Brave Search", emoji: "🦁" },
  youtube: { name: "YouTube", emoji: "📺" },
};

/**
 * OAuth provider that captures the authorization URL for manual Discord flow.
 */
class SmitheryOAuthProvider implements OAuthClientProvider {
  private _tokens?: OAuthTokens;
  private _clientInfo?: OAuthClientInformation;
  private _codeVerifier?: string;
  public capturedAuthUrl?: URL;

  get redirectUrl(): string {
    return REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return CLIENT_METADATA;
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this._clientInfo;
  }

  async saveClientInformation(info: OAuthClientInformation): Promise<void> {
    this._clientInfo = info;
  }

  tokens(): OAuthTokens | undefined {
    return this._tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this._tokens = tokens;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this.capturedAuthUrl = url;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    this._codeVerifier = verifier;
  }

  async codeVerifier(): Promise<string> {
    if (!this._codeVerifier) throw new Error("No code verifier stored");
    return this._codeVerifier;
  }

  getAccessToken(): string | undefined {
    return this._tokens?.access_token;
  }

  getRefreshToken(): string | undefined {
    return this._tokens?.refresh_token;
  }

  getExpiresIn(): number | undefined {
    return this._tokens?.expires_in;
  }
}

export const smitheryCommand = new SlashCommandBuilder()
  .setName("smithery")
  .setDescription("Authorize Smithery MCP servers (YouTube, Brave, etc.)");

export async function handleSmitheryCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  botLogger.debug(
    { user: interaction.user.username },
    "Smithery authorize command",
  );

  const embed = new EmbedBuilder()
    .setTitle("🔐 Smithery Authorization")
    .setDescription(
      "Select which MCP server to authorize.\n\n" +
        "**Each server requires separate authorization:**\n" +
        "• 🦁 **Brave Search** - Web, news, image, and local search\n" +
        "• 📺 **YouTube** - Video search, channel info, captions\n\n" +
        "You'll be redirected to Smithery to authorize, then paste the code back here.",
    )
    .setColor(0x5865f2);

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("smithery_select_server")
    .setPlaceholder("Choose a server to authorize...")
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("Brave Search")
        .setDescription("Web, news, image, and local search")
        .setValue("brave")
        .setEmoji("🦁"),
      new StringSelectMenuOptionBuilder()
        .setLabel("YouTube")
        .setDescription("Video search, channel info, captions")
        .setValue("youtube")
        .setEmoji("📺"),
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    selectMenu,
  );

  await interaction.reply({
    embeds: [embed],
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Handle server selection from dropdown
 */
export async function handleSmitherySelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  if (interaction.customId !== "smithery_select_server") return;

  await interaction.deferUpdate();

  const serverId = interaction.values[0] as SmitheryServerId;
  const serverInfo = SERVERS[serverId];
  if (!serverInfo) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("❌ Invalid Server")
          .setDescription(`Unknown server: ${serverId}`)
          .setColor(0xff0000),
      ],
      components: [],
    });
    return;
  }
  const userId = interaction.user.id;
  const serverUrl = `https://server.smithery.ai/${serverId}`;

  try {
    const provider = new SmitheryOAuthProvider();
    const result = await auth(provider, { serverUrl });

    if (result === "AUTHORIZED") {
      await showSuccess(interaction, provider, serverId);
      return;
    }

    if (result !== "REDIRECT" || !provider.capturedAuthUrl) {
      throw new Error("Authorization failed - unexpected result");
    }

    pendingFlows.set(userId, {
      provider,
      serverUrl,
      serverId,
      authUrl: provider.capturedAuthUrl,
    });

    const embed = new EmbedBuilder()
      .setTitle(`${serverInfo.emoji} Authorize ${serverInfo.name}`)
      .setDescription(
        "**Step 1:** Open Smithery authorization\n" +
          "**Step 2:** After authorizing, you'll be redirected to a page with a code\n" +
          "**Step 3:** Click Enter Authorization Code and paste the code",
      )
      .setColor(0xffa500)
      .setFooter({
        text: "The authorization code is in the URL after 'code='",
      });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel("Open Smithery")
        .setStyle(ButtonStyle.Link)
        .setURL(provider.capturedAuthUrl.toString()),
      new ButtonBuilder()
        .setCustomId("smithery_enter_code")
        .setLabel("Enter Authorization Code")
        .setStyle(ButtonStyle.Success)
    );

    await interaction.editReply({
      embeds: [embed],
      components: [row],
    });
  } catch (error) {
    botLogger.error({ error, serverId }, "Failed to start Smithery OAuth");
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("❌ Authorization Failed")
          .setDescription(
            `Failed to start OAuth flow: ${error instanceof Error ? error.message : "Unknown error"}`,
          )
          .setColor(0xff0000),
      ],
      components: [],
    });
  }
}

/**
 * Handle the "Enter Code" button - show modal
 */
export async function handleSmitheryCodeButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (interaction.customId !== "smithery_enter_code") return;

  const modal = new ModalBuilder({
    custom_id: "smithery_code_modal",
    title: "Enter Authorization Code",
    components: [
      new ActionRowBuilder<TextInputBuilder>({
        components: [
          new TextInputBuilder({
            custom_id: "auth_code",
            label: "Authorization Code",
            placeholder: "Paste the code from the redirect URL here...",
            style: TextInputStyle.Short,
            required: true,
            min_length: 10,
            max_length: 500,
          }),
        ],
      }),
    ],
  });

  await interaction.showModal(modal);
}

/**
 * Handle the modal submission with the auth code
 */
export async function handleSmitheryModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (interaction.customId !== "smithery_code_modal") return;

  await interaction.deferUpdate();

  const userId = interaction.user.id;
  const authCode = interaction.fields.getTextInputValue("auth_code").trim();

  const pendingFlow = pendingFlows.get(userId);
  if (!pendingFlow) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("❌ Session Expired")
          .setDescription(
            "Your authorization session has expired. Please run `/smithery` again.",
          )
          .setColor(0xff0000),
      ],
      components: [],
    });
    return;
  }

  try {
    const result = await auth(pendingFlow.provider, {
      serverUrl: pendingFlow.serverUrl,
      authorizationCode: authCode,
    });

    if (result !== "AUTHORIZED") {
      throw new Error("Authorization failed - unexpected result");
    }

    await showSuccess(interaction, pendingFlow.provider, pendingFlow.serverId);
    pendingFlows.delete(userId);
  } catch (error) {
    botLogger.error({ error }, "Failed to exchange Smithery auth code");
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("❌ Code Exchange Failed")
          .setDescription(
            `Failed to exchange authorization code: ${error instanceof Error ? error.message : "Unknown error"}\n\n` +
              "Make sure you copied the entire code from the URL.",
          )
          .setColor(0xff0000),
      ],
      components: [],
    });
  }
}

/**
 * Show success message after saving tokens
 */
async function showSuccess(
  interaction:
    | ButtonInteraction
    | ModalSubmitInteraction
    | StringSelectMenuInteraction,
  provider: SmitheryOAuthProvider,
  serverId: SmitheryServerId,
): Promise<void> {
  const accessToken = provider.getAccessToken();
  const refreshToken = provider.getRefreshToken();
  const expiresIn = provider.getExpiresIn();
  const serverInfo = SERVERS[serverId] ?? { name: serverId, emoji: "🔧" };

  if (!accessToken) {
    throw new Error("No access token received");
  }

  // Save tokens to database for this specific server
  await saveSmitheryTokens(serverId, {
    accessToken,
    refreshToken,
    expiresIn,
  });

  botLogger.info({ serverId }, "Smithery tokens saved to database");

  const embed = new EmbedBuilder()
    .setTitle(`${serverInfo.emoji} ${serverInfo.name} Authorized!`)
    .setDescription(
      `You've successfully authorized **${serverInfo.name}**!\n\n` +
        "Tokens have been saved and will be used automatically.\n" +
        (refreshToken
          ? "🔄 Tokens will refresh automatically when they expire."
          : "⚠️ No refresh token received - you may need to re-authorize later."),
    )
    .setColor(0x00ff00)
    .setFooter({
      text: "Run /smithery again to authorize other servers",
    });

  await interaction.editReply({
    embeds: [embed],
    components: [],
  });
}
