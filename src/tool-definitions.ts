export const TOOL_DEFINITIONS = [
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
    description: "Get the assignments for the user's courses, including due dates",
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
    name: 'get_course_pdfs_text',
    description:
      'Find visible PDF files in a Moodle course, download them, extract text, and return the extracted text',
    inputSchema: {
      type: 'object',
      properties: {
        courseId: {
          type: 'number',
          description: 'Course ID',
        },
        maxFiles: {
          type: 'number',
          description: 'Maximum number of PDFs to fetch. Defaults to 10, capped at 25.',
        },
        maxCharsPerFile: {
          type: 'number',
          description:
            'Maximum number of extracted text characters to return per PDF. Defaults to 20000, capped at 100000.',
        },
      },
      required: ['courseId'],
    },
    annotations: {
      title: 'Get course PDF text',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'get_announcements',
    description: 'Get recent course announcements from the course news/announcements forum',
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
    description:
      "Get the status of the user's own submission for an assignment, including grade and feedback received",
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
    description: "Get the quizzes for the user's courses, including open and close dates",
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
    description: "Get the user's own grade for a specific quiz",
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
];
