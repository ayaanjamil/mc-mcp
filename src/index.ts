#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios, { AxiosInstance } from 'axios';
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

// Interfaces for the data types
interface Course {
  id: number;
  shortname: string;
  fullname: string;
  startdate: number;
  enddate: number;
  progress?: number;
}

interface Assignment {
  id: number;
  name: string;
  duedate: number;
  allowsubmissionsfromdate: number;
  grade: number;
  timemodified: number;
  cutoffdate: number;
}

class MoodleMcpServer {
  private server: Server;
  private client?: AxiosInstance;
  private configResult: ConfigResult;
  private userId?: number;

  constructor() {
    this.configResult = loadConfig();

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

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_my_courses',
          description: 'Get the list of courses the user is enrolled in',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
          annotations: {
            title: 'Get my courses',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        {
          name: 'get_assignments',
          description: 'Get the assignments for the user\'s courses, including due dates',
          inputSchema: {
            type: 'object',
            properties: {
              courseId: {
                type: 'number',
                description: 'Optional course ID. If not provided, all enrolled courses are used.',
              },
            },
            required: [],
          },
          annotations: {
            title: 'Get assignments',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        {
          name: 'get_pending_assignments',
          description: 'Get the assignments the user has not submitted yet, sorted by due date',
          inputSchema: {
            type: 'object',
            properties: {
              courseId: {
                type: 'number',
                description: 'Optional course ID. If not provided, all enrolled courses are used.',
              },
            },
            required: [],
          },
          annotations: {
            title: 'Get pending assignments',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        {
          name: 'get_my_submission_status',
          description: 'Get the status of the user\'s own submission for an assignment, including grade and feedback received',
          inputSchema: {
            type: 'object',
            properties: {
              assignmentId: {
                type: 'number',
                description: 'Assignment ID',
              },
            },
            required: ['assignmentId'],
          },
          annotations: {
            title: 'Get my submission status',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        {
          name: 'get_quizzes',
          description: 'Get the quizzes for the user\'s courses, including open and close dates',
          inputSchema: {
            type: 'object',
            properties: {
              courseId: {
                type: 'number',
                description: 'Optional course ID. If not provided, all enrolled courses are used.',
              },
            },
            required: [],
          },
          annotations: {
            title: 'Get quizzes',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        {
          name: 'get_my_quiz_grade',
          description: 'Get the user\'s own grade for a specific quiz',
          inputSchema: {
            type: 'object',
            properties: {
              quizId: {
                type: 'number',
                description: 'Quiz ID',
              },
            },
            required: ['quizId'],
          },
          annotations: {
            title: 'Get my quiz grade',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        {
          name: 'moodle_check_setup',
          description:
            'Diagnose the Moodle connection. Use this when another Moodle tool fails, or when the user asks why Moodle is not working. Reports whether the settings file exists, whether the site is reachable, and whether the token is still valid.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
          annotations: {
            title: 'Check Moodle setup',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
      ],
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
    switch (name) {
      case 'get_my_courses':
        return await this.getMyCourses();
      case 'get_assignments':
        return await this.getAssignments(args);
      case 'get_pending_assignments':
        return await this.getPendingAssignments(args);
      case 'get_my_submission_status':
        return await this.getMySubmissionStatus(args);
      case 'get_quizzes':
        return await this.getQuizzes(args);
      case 'get_my_quiz_grade':
        return await this.getMyQuizGrade(args);
      case 'moodle_check_setup':
        return await this.checkSetup();
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  }

  private errorResult(text: string) {
    return { content: [{ type: 'text', text }], isError: true };
  }

  private toErrorResult(error: unknown) {
    console.error('[Error]', error);

    if (error instanceof SetupRequiredError) {
      return this.errorResult(setupMessage(error.result));
    }

    if (error instanceof MoodleApiError) {
      return this.errorResult(error.userMessage);
    }

    if (error instanceof MoodleNetworkError) {
      return this.errorResult(error.message);
    }

    if (axios.isAxiosError(error)) {
      const host = this.configResult.ok
        ? new URL(this.configResult.config.siteUrl).host
        : 'your Moodle site';
      return this.errorResult(describeNetworkError(error, host));
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
      return { content: [{ type: 'text', text: lines.join('\n') }] };
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
        `Site reachable: yes — "${publicConfig.sitename}", app connections ${enabled ? 'enabled' : 'DISABLED on the site'}`
      );
    } catch (error) {
      lines.push(
        `Site reachable: NO — ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      const siteInfo = await verifyToken(siteUrl, this.configResult.config.token);
      lines.push(`Token: valid — signed in as ${siteInfo.username} (id ${siteInfo.userid})`);

      const available = new Set((siteInfo.functions ?? []).map((fn) => fn.name));
      const missing = REQUIRED_WSFUNCTIONS.filter((fn) => !available.has(fn));
      if (available.size === 0) {
        lines.push('Functions: the site did not list them.');
      } else if (missing.length === 0) {
        lines.push(`Functions: all ${REQUIRED_WSFUNCTIONS.length} required ones are available.`);
      } else {
        lines.push(`Functions: missing ${missing.join(', ')} — the tools using them will fail.`);
      }
    } catch (error) {
      if (error instanceof MoodleApiError) {
        lines.push(`Token: NOT valid — ${error.errorcode}`, '', error.userMessage);
      } else {
        lines.push(
          `Token: could not be checked — ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    lines.push('', `For a full checkup run: cd ${repoRoot} && npm run doctor`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
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

  // Moodle revokes tokens on password change, so an expired token is the most
  // common recurring failure. Re-reading the config lets `npm run setup` take
  // effect without the user having to fully quit and reopen Claude.
  private reloadConfig(): boolean {
    const previousToken = this.configResult.ok ? this.configResult.config.token : undefined;

    this.client = undefined;
    this.userId = undefined;
    this.configResult = loadConfig();

    return (
      this.configResult.ok && this.configResult.config.token !== previousToken
    );
  }

  // The token identifies the user, so their ID is resolved only once
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

  private async getCourseIds(args: any = {}): Promise<number[]> {
    if (args?.courseId) {
      return [args.courseId];
    }

    const courses = await this.fetchMyCourses();
    return courses.map((course) => course.id);
  }

  private async fetchMyCourses(): Promise<Course[]> {
    const userId = await this.getUserId();

    console.error(`[API] Requesting courses for user ${userId}`);

    const response = await this.ensureClient().get('', {
      params: {
        wsfunction: 'core_enrol_get_users_courses',
        userid: userId,
      },
    });

    return (response.data || []).map((course: any) => ({
      id: course.id,
      shortname: course.shortname,
      fullname: course.fullname,
      startdate: course.startdate,
      enddate: course.enddate,
      progress: course.progress,
    }));
  }

  private async fetchAssignments(courseIds: number[]) {
    if (courseIds.length === 0) {
      return [];
    }

    console.error(`[API] Requesting assignments for courses ${courseIds.join(', ')}`);

    const response = await this.ensureClient().get('', {
      params: {
        wsfunction: 'mod_assign_get_assignments',
        courseids: courseIds,
      },
    });

    const courses = response.data.courses || [];

    return courses.flatMap((course: any) =>
      (course.assignments || []).map((assignment: Assignment) => ({
        ...assignment,
        courseId: course.id,
        courseName: course.fullname,
      }))
    );
  }

  private async getMyCourses() {
    const courses = await this.fetchMyCourses();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(courses, null, 2),
        },
      ],
    };
  }

  private async getAssignments(args: any = {}) {
    const courseIds = await this.getCourseIds(args);
    const assignments = await this.fetchAssignments(courseIds);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(assignments, null, 2),
        },
      ],
    };
  }

  private async getPendingAssignments(args: any = {}) {
    const userId = await this.getUserId();
    const courseIds = await this.getCourseIds(args);
    const assignments = await this.fetchAssignments(courseIds);

    const statuses = await Promise.all(
      assignments.map(async (assignment: any) => {
        const response = await this.ensureClient().get('', {
          params: {
            wsfunction: 'mod_assign_get_submission_status',
            assignid: assignment.id,
            userid: userId,
          },
        });

        return {
          assignment,
          status: response.data.lastattempt?.submission?.status || 'new',
        };
      })
    );

    const pending = statuses
      .filter(({ status }) => status !== 'submitted')
      .map(({ assignment, status }) => ({
        id: assignment.id,
        name: assignment.name,
        courseId: assignment.courseId,
        courseName: assignment.courseName,
        status,
        duedate: assignment.duedate
          ? new Date(assignment.duedate * 1000).toISOString()
          : 'No due date',
        cutoffdate: assignment.cutoffdate
          ? new Date(assignment.cutoffdate * 1000).toISOString()
          : 'No cut-off date',
        duedateTimestamp: assignment.duedate,
      }))
      .sort((a, b) => (a.duedateTimestamp || Infinity) - (b.duedateTimestamp || Infinity))
      .map(({ duedateTimestamp, ...assignment }) => assignment);

    return {
      content: [
        {
          type: 'text',
          text: pending.length > 0
            ? JSON.stringify(pending, null, 2)
            : 'There are no pending assignments to submit.',
        },
      ],
    };
  }

  private async getMySubmissionStatus(args: any) {
    if (!args?.assignmentId) {
      throw new McpError(ErrorCode.InvalidParams, 'Assignment ID is required');
    }

    const userId = await this.getUserId();

    console.error(`[API] Requesting submission status for assignment ${args.assignmentId}`);

    const response = await this.ensureClient().get('', {
      params: {
        wsfunction: 'mod_assign_get_submission_status',
        assignid: args.assignmentId,
        userid: userId,
      },
    });

    const lastAttempt = response.data.lastattempt || {};
    const submission = lastAttempt.submission || {};
    const feedback = response.data.feedback || {};

    const result = {
      assignmentId: args.assignmentId,
      status: submission.status || 'new',
      gradingStatus: lastAttempt.gradingstatus || 'notgraded',
      submitted: submission.status === 'submitted',
      timemodified: submission.timemodified
        ? new Date(submission.timemodified * 1000).toISOString()
        : 'Not submitted',
      grade: feedback.grade?.grade ?? 'Not graded',
      gradeForDisplay: feedback.gradefordisplay || null,
      feedback: feedback.plugins
        ?.flatMap((plugin: any) => plugin.editorfields || [])
        .map((field: any) => field.text)
        .filter(Boolean) || [],
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async getQuizzes(args: any = {}) {
    const courseIds = await this.getCourseIds(args);

    if (courseIds.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify([], null, 2) }],
      };
    }

    console.error(`[API] Requesting quizzes for courses ${courseIds.join(', ')}`);

    const response = await this.ensureClient().get('', {
      params: {
        wsfunction: 'mod_quiz_get_quizzes_by_courses',
        courseids: courseIds,
      },
    });

    const quizzes = response.data.quizzes || [];

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(quizzes, null, 2),
        },
      ],
    };
  }

  private async getMyQuizGrade(args: any) {
    if (!args?.quizId) {
      throw new McpError(ErrorCode.InvalidParams, 'Quiz ID is required');
    }

    const userId = await this.getUserId();

    console.error(`[API] Requesting quiz grade for quiz ${args.quizId}`);

    const response = await this.ensureClient().get('', {
      params: {
        wsfunction: 'mod_quiz_get_user_best_grade',
        quizid: args.quizId,
        userid: userId,
      },
    });

    const result = {
      quizId: args.quizId,
      hasGrade: response.data.hasgrade,
      grade: response.data.hasgrade ? response.data.grade : 'Not graded',
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Moodle MCP server running on stdio');
  }
}

const server = new MoodleMcpServer();
server.run().catch(console.error);
