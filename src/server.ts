import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigResult, loadConfig } from './config.js';
import {
  MoodleApiError,
  MoodleNetworkError,
  REQUIRED_WSFUNCTIONS,
  createClient,
  describeNetworkError,
  fetchPublicConfig,
  verifyToken,
} from './moodle.js';
import { MoodleToolHandlers } from './moodle-tools.js';
import { TOOL_DEFINITIONS } from './tool-definitions.js';
import { textResult } from './tool-utils.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Thrown when a tool is called before setup has run. Deliberately not thrown at
// module load: a top-level throw kills the process before the stdio transport
// connects, and the client can only report "server disconnected".
class SetupRequiredError extends Error {
  constructor(readonly result: Extract<ConfigResult, { ok: false }>) {
    super('Moodle is not set up yet');
    this.name = 'SetupRequiredError';
  }
}

function setupMessage(result: Extract<ConfigResult, { ok: false }>): string {
  const command = `cd ${repoRoot} && npm run setup`;

  switch (result.reason) {
    case 'malformed':
      return (
        `The Moodle settings file at ${result.path} is damaged` +
        `${result.detail ? ` (${result.detail})` : ''}.\n\n` +
        `Fix: run this in a terminal to recreate it:\n\n    ${command}`
      );
    case 'incomplete':
      return (
        `The Moodle settings at ${result.path} are incomplete` +
        `${result.detail ? ` (${result.detail})` : ''}.\n\n` +
        `Fix: run this in a terminal:\n\n    ${command}`
      );
    default:
      return (
        'Moodle is not connected yet.\n\n' +
        `Fix: run this in a terminal:\n\n    ${command}\n\n` +
        'It walks you through signing in to your Moodle site once, then Claude ' +
        'can read your courses, deadlines and grades.'
      );
  }
}

export class MoodleMcpServer {
  private server: Server;
  private client?: AxiosInstance;
  private configResult: ConfigResult;
  private toolHandlers: MoodleToolHandlers;
  private userId?: number;

  constructor() {
    this.configResult = loadConfig();
    this.toolHandlers = new MoodleToolHandlers({
      getClient: () => this.ensureClient(),
      getToken: () => this.getToken(),
      getUserId: () => this.getUserId(),
    });

    this.server = new Server(
      {
        name: 'moodle-mcp-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOL_DEFINITIONS,
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.error(`[Tool] Executing tool: ${request.params.name}`);

      try {
        return await this.dispatch(request.params.name, request.params.arguments);
      } catch (error) {
        // An auth failure may just mean the user re-ran setup since this
        // process started. Re-read the config and retry exactly once.
        if (error instanceof MoodleApiError && error.isAuthFailure) {
          if (this.reloadConfig()) {
            console.error('[Auth] Token changed on disk, retrying once');
            try {
              return await this.dispatch(request.params.name, request.params.arguments);
            } catch (retryError) {
              return this.toErrorResult(retryError);
            }
          }
        }

        return this.toErrorResult(error);
      }
    });
  }

  private async dispatch(name: string, args: unknown) {
    if (name === 'moodle_check_setup') {
      return await this.checkSetup();
    }

    return await this.toolHandlers.dispatch(name, args);
  }

  private toErrorResult(error: unknown) {
    console.error('[Error]', error);

    if (error instanceof SetupRequiredError) {
      return textResult(setupMessage(error.result), true);
    }

    if (error instanceof MoodleApiError) {
      const hint = error.isAuthFailure ? this.envOverrideHint() : undefined;
      return textResult(hint ? `${error.userMessage}\n\n${hint}` : error.userMessage, true);
    }

    if (error instanceof MoodleNetworkError) {
      return textResult(error.message, true);
    }

    if (axios.isAxiosError(error)) {
      const host = this.configResult.ok
        ? new URL(this.configResult.config.siteUrl).host
        : 'your Moodle site';
      return textResult(describeNetworkError(error, host), true);
    }

    if (error instanceof McpError) {
      throw error;
    }

    throw error;
  }

  // Works with no config on purpose: "why isn't Moodle working?" should be
  // answerable in the chat rather than by reading server logs.
  private async checkSetup() {
    const lines: string[] = [];

    if (!this.configResult.ok) {
      lines.push('Not connected to Moodle yet.', '', setupMessage(this.configResult));
      return textResult(lines.join('\n'));
    }

    const { siteUrl } = this.configResult.config;
    lines.push(`Settings file: ${this.configResult.path}`);
    lines.push(`Site: ${siteUrl}`);
    if (this.configResult.source !== 'file') {
      lines.push(
        'Note: MOODLE_API_URL/MOODLE_API_TOKEN in the environment are overriding the settings file.'
      );
    }

    try {
      const publicConfig = await fetchPublicConfig(siteUrl);
      const enabled =
        publicConfig.enablewebservices === 1 && publicConfig.enablemobilewebservice === 1;
      lines.push(
        `Site reachable: yes - "${publicConfig.sitename}", app connections ${enabled ? 'enabled' : 'DISABLED on the site'}`
      );
    } catch (error) {
      lines.push(
        `Site reachable: NO - ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      const siteInfo = await verifyToken(siteUrl, this.configResult.config.token);
      lines.push(`Token: valid - signed in as ${siteInfo.username} (id ${siteInfo.userid})`);

      const available = new Set((siteInfo.functions ?? []).map((fn) => fn.name));
      const missing = REQUIRED_WSFUNCTIONS.filter((fn) => !available.has(fn));
      if (available.size === 0) {
        lines.push('Functions: the site did not list them.');
      } else if (missing.length === 0) {
        lines.push(`Functions: all ${REQUIRED_WSFUNCTIONS.length} required ones are available.`);
      } else {
        lines.push(`Functions: missing ${missing.join(', ')} - the tools using them will fail.`);
      }
    } catch (error) {
      if (error instanceof MoodleApiError) {
        lines.push(`Token: NOT valid - ${error.errorcode}`, '', error.userMessage);
      } else {
        lines.push(
          `Token: could not be checked - ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    lines.push('', `For a full checkup run: cd ${repoRoot} && npm run doctor`);

    return textResult(lines.join('\n'));
  }

  private ensureClient(): AxiosInstance {
    if (this.client) {
      return this.client;
    }

    if (!this.configResult.ok) {
      throw new SetupRequiredError(this.configResult);
    }

    const { siteUrl, token } = this.configResult.config;
    this.client = createClient(siteUrl, token);
    return this.client;
  }

  private getToken(): string {
    if (!this.configResult.ok) {
      throw new SetupRequiredError(this.configResult);
    }

    return this.configResult.config.token;
  }

  // An env token shadows the settings file, so re-running setup cannot fix an
  // auth failure and the retry below can never see a new token. Saying so is
  // the difference between a one-line fix and an unfalsifiable "token invalid".
  private envOverrideHint(): string | undefined {
    if (!this.configResult.ok || this.configResult.source === 'file') {
      return undefined;
    }

    if (!process.env.MOODLE_API_TOKEN?.trim()) {
      return undefined;
    }

    return (
      'Note: MOODLE_API_TOKEN is set in this server\'s environment, and it takes ' +
      `precedence over the token in ${this.configResult.path}. Re-running setup ` +
      'cannot fix this. Remove MOODLE_API_TOKEN (and MOODLE_API_URL) from the ' +
      'moodle server entry in your MCP client config so the settings file is used, ' +
      'or update the token there.'
    );
  }

  // Moodle revokes tokens on password change, so an expired token is the most
  // common recurring failure. Re-reading the config lets `npm run setup` take
  // effect without the user having to fully quit and reopen Claude.
  private reloadConfig(): boolean {
    const previousToken = this.configResult.ok ? this.configResult.config.token : undefined;

    this.client = undefined;
    this.userId = undefined;
    this.configResult = loadConfig();

    return this.configResult.ok && this.configResult.config.token !== previousToken;
  }

  // The token identifies the user, so their ID is resolved only once.
  private async getUserId(): Promise<number> {
    if (this.userId !== undefined) {
      return this.userId;
    }

    console.error('[API] Requesting site info');

    const response = await this.ensureClient().get('', {
      params: {
        wsfunction: 'core_webservice_get_site_info',
      },
    });

    if (!response.data?.userid) {
      throw new McpError(
        ErrorCode.InternalError,
        'Could not determine the user associated with the Moodle token'
      );
    }

    this.userId = response.data.userid;
    return response.data.userid;
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Moodle MCP server running on stdio');
  }
}
