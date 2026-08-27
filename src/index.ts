#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';

// Environment variable configuration
const MOODLE_API_URL = process.env.MOODLE_API_URL;
const MOODLE_API_TOKEN = process.env.MOODLE_API_TOKEN;

// Verify that the environment variables are defined
if (!MOODLE_API_URL) {
  throw new Error('MOODLE_API_URL environment variable is required');
}

if (!MOODLE_API_TOKEN) {
  throw new Error('MOODLE_API_TOKEN environment variable is required');
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
  private axiosInstance;
  private userId?: number;

  constructor() {
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

    this.axiosInstance = axios.create({
      baseURL: MOODLE_API_URL,
      params: {
        wstoken: MOODLE_API_TOKEN,
        moodlewsrestformat: 'json',
      },
    });

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
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.error(`[Tool] Executing tool: ${request.params.name}`);

      try {
        switch (request.params.name) {
          case 'get_my_courses':
            return await this.getMyCourses();
          case 'get_assignments':
            return await this.getAssignments(request.params.arguments);
          case 'get_pending_assignments':
            return await this.getPendingAssignments(request.params.arguments);
          case 'get_my_submission_status':
            return await this.getMySubmissionStatus(request.params.arguments);
          case 'get_quizzes':
            return await this.getQuizzes(request.params.arguments);
          case 'get_my_quiz_grade':
            return await this.getMyQuizGrade(request.params.arguments);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        console.error('[Error]', error);
        if (axios.isAxiosError(error)) {
          return {
            content: [
              {
                type: 'text',
                text: `Moodle API error: ${error.response?.data?.message || error.message
                  }`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      }
    });
  }

  // The token identifies the user, so their ID is resolved only once
  private async getUserId(): Promise<number> {
    if (this.userId !== undefined) {
      return this.userId;
    }

    console.error('[API] Requesting site info');

    const response = await this.axiosInstance.get('', {
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

    const response = await this.axiosInstance.get('', {
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

    const response = await this.axiosInstance.get('', {
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
        const response = await this.axiosInstance.get('', {
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

    const response = await this.axiosInstance.get('', {
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

    const response = await this.axiosInstance.get('', {
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

    const response = await this.axiosInstance.get('', {
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
