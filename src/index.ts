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

interface CourseModule {
  id: number;
  name: string;
  modname: string;
  modplural?: string;
  instance?: number;
  url?: string;
  description?: string;
  contents?: {
    type?: string;
    filename?: string;
    filepath?: string;
    filesize?: number;
    fileurl?: string;
    mimetype?: string;
    timemodified?: number;
  }[];
}

interface CourseSection {
  id: number;
  name?: string;
  summary?: string;
  section: number;
  modules?: CourseModule[];
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
          name: 'get_course_contents',
          description:
            'Get the visible course page contents: sections, resources, activities, links, descriptions, and downloadable files',
          inputSchema: {
            type: 'object',
            properties: {
              courseId: {
                type: 'number',
                description: 'Course ID',
              },
            },
            required: ['courseId'],
          },
          annotations: {
            title: 'Get course contents',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        {
          name: 'get_announcements',
          description:
            'Get recent course announcements from the course news/announcements forum',
          inputSchema: {
            type: 'object',
            properties: {
              courseId: {
                type: 'number',
                description: 'Course ID',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of announcements to return. Defaults to 10.',
              },
            },
            required: ['courseId'],
          },
          annotations: {
            title: 'Get announcements',
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
          name: 'get_lecture_schedule',
          description:
            'Get upcoming Moodle calendar events for enrolled courses, useful for lecture schedules, sessions, and course events',
          inputSchema: {
            type: 'object',
            properties: {
              courseId: {
                type: 'number',
                description: 'Optional course ID. If not provided, all enrolled courses are used.',
              },
              daysAhead: {
                type: 'number',
                description: 'How many days ahead to search. Defaults to 120.',
              },
            },
            required: [],
          },
          annotations: {
            title: 'Get lecture schedule',
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
      case 'get_course_contents':
        return await this.getCourseContents(args);
      case 'get_announcements':
        return await this.getAnnouncements(args);
      case 'get_pending_assignments':
        return await this.getPendingAssignments(args);
      case 'get_my_submission_status':
        return await this.getMySubmissionStatus(args);
      case 'get_quizzes':
        return await this.getQuizzes(args);
      case 'get_my_quiz_grade':
        return await this.getMyQuizGrade(args);
      case 'get_lecture_schedule':
        return await this.getLectureSchedule(args);
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

  private cleanText(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const cleaned = value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return cleaned || undefined;
  }

  private positiveIntegerArg(args: any, name: string, fallback?: number): number {
    const raw = args?.[name];

    if (raw === undefined || raw === null) {
      if (fallback !== undefined) {
        return fallback;
      }
      throw new McpError(ErrorCode.InvalidParams, `${name} is required`);
    }

    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new McpError(ErrorCode.InvalidParams, `${name} must be a positive integer`);
    }

    return value;
  }

  private async fetchForumDiscussions(forumId: number, limit: number) {
    const client = this.ensureClient();

    try {
      const response = await client.get('', {
        params: {
          wsfunction: 'mod_forum_get_forum_discussions',
          forumid: forumId,
          page: 0,
          perpage: limit,
        },
      });

      return response.data.discussions || [];
    } catch (error) {
      if (!(error instanceof MoodleApiError) || error.errorcode !== 'servicenotavailable') {
        throw error;
      }

      const response = await client.get('', {
        params: {
          wsfunction: 'mod_forum_get_forum_discussions_paginated',
          forumid: forumId,
          page: 0,
          perpage: limit,
          sortby: 'timemodified',
          sortdirection: 'DESC',
        },
      });

      return response.data.discussions || [];
    }
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

  private async getCourseContents(args: any) {
    const courseId = this.positiveIntegerArg(args, 'courseId');

    console.error(`[API] Requesting course contents for course ${courseId}`);

    const response = await this.ensureClient().get('', {
      params: {
        wsfunction: 'core_course_get_contents',
        courseid: courseId,
      },
    });

    const sections = (response.data || []).map((section: CourseSection) => ({
      id: section.id,
      section: section.section,
      name: this.cleanText(section.name),
      summary: this.cleanText(section.summary),
      modules: (section.modules || []).map((module: CourseModule) => ({
        id: module.id,
        name: module.name,
        type: module.modname,
        typeName: module.modplural,
        instance: module.instance,
        url: module.url,
        description: this.cleanText(module.description),
        files: (module.contents || []).map((content) => ({
          type: content.type,
          filename: content.filename,
          filepath: content.filepath,
          filesize: content.filesize,
          fileurl: content.fileurl,
          mimetype: content.mimetype,
          timemodified: content.timemodified
            ? new Date(content.timemodified * 1000).toISOString()
            : undefined,
        })),
      })),
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(sections, null, 2),
        },
      ],
    };
  }

  private async getAnnouncements(args: any) {
    const courseId = this.positiveIntegerArg(args, 'courseId');
    const limit = Math.min(this.positiveIntegerArg(args, 'limit', 10), 50);

    console.error(`[API] Requesting announcements for course ${courseId}`);

    const forumsResponse = await this.ensureClient().get('', {
      params: {
        wsfunction: 'mod_forum_get_forums_by_courses',
        courseids: [courseId],
      },
    });

    const forums = forumsResponse.data || [];
    const announcementForums = forums.filter((forum: any) => {
      const name = String(forum.name || '').toLowerCase();
      return forum.type === 'news' || name.includes('announcement') || name.includes('news');
    });

    const forumsToRead = announcementForums.length > 0 ? announcementForums : forums;
    const discussions = (
      await Promise.all(
        forumsToRead.map(async (forum: any) => {
          const forumDiscussions = await this.fetchForumDiscussions(forum.id, limit);
          return forumDiscussions.map((discussion: any) => ({
            id: discussion.discussion ?? discussion.id,
            postId: discussion.id,
            forumId: forum.id,
            forumName: forum.name,
            subject: discussion.name || discussion.subject,
            message: this.cleanText(discussion.message),
            author: discussion.userfullname,
            created: discussion.created
              ? new Date(discussion.created * 1000).toISOString()
              : undefined,
            modified: discussion.timemodified
              ? new Date(discussion.timemodified * 1000).toISOString()
              : undefined,
            pinned: discussion.pinned,
            unread: discussion.numunread ?? discussion.unreadpostscount,
          }));
        })
      )
    )
      .flat()
      .sort((a, b) => Date.parse(b.modified || b.created || '0') - Date.parse(a.modified || a.created || '0'))
      .slice(0, limit);

    return {
      content: [
        {
          type: 'text',
          text:
            discussions.length > 0
              ? JSON.stringify(discussions, null, 2)
              : 'No announcements were found for this course.',
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

  private async getLectureSchedule(args: any = {}) {
    const courseIds = await this.getCourseIds(args);
    const daysAhead = Math.min(this.positiveIntegerArg(args, 'daysAhead', 120), 366);
    const now = Math.floor(Date.now() / 1000);
    const timeEnd = now + daysAhead * 24 * 60 * 60;

    if (courseIds.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify([], null, 2) }],
      };
    }

    console.error(
      `[API] Requesting calendar events for courses ${courseIds.join(', ')} over ${daysAhead} days`
    );

    const response = await this.ensureClient().get('', {
      params: {
        wsfunction: 'core_calendar_get_calendar_events',
        events: {
          courseids: courseIds,
          groupids: [],
          eventids: [],
        },
        options: {
          userevents: false,
          siteevents: false,
          timestart: now,
          timeend: timeEnd,
          ignorehidden: true,
        },
      },
    });

    const events = (response.data.events || [])
      .map((event: any) => ({
        id: event.id,
        name: event.name,
        description: this.cleanText(event.description),
        courseId: event.courseid,
        groupId: event.groupid,
        eventType: event.eventtype,
        moduleName: event.modulename,
        instance: event.instance,
        url: event.url,
        start: event.timestart ? new Date(event.timestart * 1000).toISOString() : undefined,
        durationSeconds: event.timeduration,
        visible: event.visible,
      }))
      .sort((a: any, b: any) => Date.parse(a.start || '0') - Date.parse(b.start || '0'));

    return {
      content: [
        {
          type: 'text',
          text:
            events.length > 0
              ? JSON.stringify(events, null, 2)
              : `No course calendar events were found in the next ${daysAhead} days.`,
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
