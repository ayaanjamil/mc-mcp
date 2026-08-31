import axios, { AxiosInstance } from 'axios';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
// Imported by lib path on purpose: pdf-parse's index.js reads a bundled test
// PDF at import time whenever `module.parent` is falsy, which is always true
// under ESM, and that crashes the server on startup.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { MoodleApiError } from './moodle.js';
import { Assignment, Course, CourseModule, CourseSection } from './types.js';
import {
  cleanText,
  jsonResult,
  positiveIntegerArg,
  settleWithConcurrency,
  textResult,
} from './tool-utils.js';

const PDF_DOWNLOAD_TIMEOUT_MS = 60000;
const PDF_MAX_BYTES = 40 * 1024 * 1024;
const PDF_DOWNLOAD_CONCURRENCY = 4;

interface MoodleToolDeps {
  getClient: () => AxiosInstance;
  getToken: () => string;
  getUserId: () => Promise<number>;
}

interface CoursePdf {
  courseId: number;
  sectionId: number;
  sectionName?: string;
  moduleId: number;
  moduleName: string;
  filename?: string;
  fileurl: string;
  filesize?: number;
  timemodified?: number;
}

// pdf.js prints font warnings with console.log, and stdout carries the
// JSON-RPC stream, so anything it writes there corrupts the protocol.
async function parseWithoutStdout(body: Buffer) {
  const { log, warn, info } = console;
  console.log = console.warn = console.info = (...args: unknown[]) => {
    process.stderr.write(`[pdf] ${args.join(' ')}\n`);
  };

  try {
    return await pdfParse(body);
  } finally {
    Object.assign(console, { log, warn, info });
  }
}

export class MoodleToolHandlers {
  constructor(private readonly deps: MoodleToolDeps) {}

  async dispatch(name: string, args: unknown) {
    switch (name) {
      case 'get_my_courses':
        return await this.getMyCourses();
      case 'get_assignments':
        return await this.getAssignments(args);
      case 'get_course_contents':
        return await this.getCourseContents(args);
      case 'get_course_pdfs_text':
        return await this.getCoursePdfsText(args);
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
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  }

  private get client(): AxiosInstance {
    return this.deps.getClient();
  }

  private async getCourseIds(args: any = {}): Promise<number[]> {
    if (args?.courseId) {
      return [args.courseId];
    }

    const courses = await this.fetchMyCourses();
    return courses.map((course) => course.id);
  }

  private async fetchMyCourses(): Promise<Course[]> {
    const userId = await this.deps.getUserId();

    console.error(`[API] Requesting courses for user ${userId}`);

    const response = await this.client.get('', {
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

    const response = await this.client.get('', {
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

  private async fetchCourseSections(courseId: number): Promise<CourseSection[]> {
    console.error(`[API] Requesting course contents for course ${courseId}`);

    const response = await this.client.get('', {
      params: {
        wsfunction: 'core_course_get_contents',
        courseid: courseId,
      },
    });

    return response.data || [];
  }

  private withFileToken(fileurl: string): string {
    const url = new URL(fileurl);
    if (!url.searchParams.has('token')) {
      url.searchParams.set('token', this.deps.getToken());
    }
    return url.toString();
  }

  private findCoursePdfs(courseId: number, sections: CourseSection[]): CoursePdf[] {
    return sections.flatMap((section) =>
      (section.modules || [])
        // uservisible is Moodle's own answer to "can this user open it", so it
        // covers hidden modules and unmet access restrictions alike.
        .filter((module) => module.uservisible !== false && module.visible !== 0)
        .flatMap((module) =>
          (module.contents || [])
            .filter((content) => {
              const filename = content.filename || '';
              return (
                Boolean(content.fileurl) &&
                (content.mimetype === 'application/pdf' ||
                  filename.toLowerCase().endsWith('.pdf'))
              );
            })
            .map((content) => ({
              courseId,
              sectionId: section.id,
              sectionName: cleanText(section.name),
              moduleId: module.id,
              moduleName: module.name,
              filename: content.filename,
              fileurl: content.fileurl as string,
              filesize: content.filesize,
              timemodified: content.timemodified,
            }))
        )
    );
  }

  private nonPdfError(body: Buffer, contentType: string): Error {
    // pluginfile.php reports its own failures as HTTP 200 with a JSON body, so
    // an arraybuffer response that is not a PDF is where those surface.
    try {
      const parsed = JSON.parse(body.subarray(0, 4096).toString('utf8'));
      if (typeof parsed?.errorcode === 'string') {
        return new MoodleApiError(parsed.errorcode, parsed.message ?? '', parsed.exception);
      }
    } catch {
      // Not JSON; fall through to the generic message.
    }

    return new Error(
      `the download was not a PDF (content-type: ${contentType || 'unknown'})`
    );
  }

  private async downloadPdf(fileurl: string): Promise<Buffer> {
    // Deliberately not this.client: its default params (wstoken,
    // moodlewsrestformat) and 20s timeout belong to the REST endpoint, not to
    // pluginfile.php downloads.
    const response = await axios.get<ArrayBuffer>(this.withFileToken(fileurl), {
      responseType: 'arraybuffer',
      timeout: PDF_DOWNLOAD_TIMEOUT_MS,
      maxContentLength: PDF_MAX_BYTES,
      maxBodyLength: PDF_MAX_BYTES,
    });

    const body = Buffer.from(response.data);

    if (body.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw this.nonPdfError(body, String(response.headers['content-type'] ?? ''));
    }

    return body;
  }

  private async extractPdfText(pdf: CoursePdf, maxChars: number) {
    if (pdf.filesize && pdf.filesize > PDF_MAX_BYTES) {
      throw new Error(
        `the file is ${Math.round(pdf.filesize / 1024 / 1024)} MB, above the ` +
          `${PDF_MAX_BYTES / 1024 / 1024} MB download limit`
      );
    }

    const parsed = await parseWithoutStdout(await this.downloadPdf(pdf.fileurl));
    const text = parsed.text.trim();
    const truncated = text.length > maxChars;

    return {
      courseId: pdf.courseId,
      sectionId: pdf.sectionId,
      sectionName: pdf.sectionName,
      moduleId: pdf.moduleId,
      moduleName: pdf.moduleName,
      filename: pdf.filename,
      fileurl: pdf.fileurl,
      filesize: pdf.filesize,
      modified: pdf.timemodified ? new Date(pdf.timemodified * 1000).toISOString() : undefined,
      pages: parsed.numpages,
      characters: text.length,
      text: truncated ? text.slice(0, maxChars) : text,
      truncated,
    };
  }

  private async fetchForumDiscussions(forumId: number, limit: number) {
    try {
      const response = await this.client.get('', {
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

      const response = await this.client.get('', {
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
    return jsonResult(courses);
  }

  private async getAssignments(args: any = {}) {
    const courseIds = await this.getCourseIds(args);
    const assignments = await this.fetchAssignments(courseIds);
    return jsonResult(assignments);
  }

  private async getCourseContents(args: any) {
    const courseId = positiveIntegerArg(args, 'courseId');
    const courseSections = await this.fetchCourseSections(courseId);

    const sections = courseSections.map((section: CourseSection) => ({
      id: section.id,
      section: section.section,
      name: cleanText(section.name),
      summary: cleanText(section.summary),
      modules: (section.modules || []).map((module: CourseModule) => ({
        id: module.id,
        name: module.name,
        type: module.modname,
        typeName: module.modplural,
        instance: module.instance,
        url: module.url,
        description: cleanText(module.description),
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

    return jsonResult(sections);
  }

  private async getCoursePdfsText(args: any) {
    const courseId = positiveIntegerArg(args, 'courseId');
    const maxFiles = Math.min(positiveIntegerArg(args, 'maxFiles', 10), 25);
    const maxCharsPerFile = Math.min(
      positiveIntegerArg(args, 'maxCharsPerFile', 20000),
      100000
    );
    const sections = await this.fetchCourseSections(courseId);
    const pdfs = this.findCoursePdfs(courseId, sections).slice(0, maxFiles);

    if (pdfs.length === 0) {
      return textResult('No PDF files were found in this course.');
    }

    console.error(`[API] Downloading ${pdfs.length} PDF file(s) for course ${courseId}`);

    const results = await settleWithConcurrency(pdfs, PDF_DOWNLOAD_CONCURRENCY, (pdf) =>
      this.extractPdfText(pdf, maxCharsPerFile)
    );

    return jsonResult(
      results.map((result, index) => {
        if (result.status === 'fulfilled') {
          return result.value;
        }

        const error = result.reason;
        return {
          ...pdfs[index],
          error: error instanceof Error ? error.message : String(error),
        };
      })
    );
  }

  private async getAnnouncements(args: any) {
    const courseId = positiveIntegerArg(args, 'courseId');
    const limit = Math.min(positiveIntegerArg(args, 'limit', 10), 50);

    console.error(`[API] Requesting announcements for course ${courseId}`);

    const forumsResponse = await this.client.get('', {
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
            message: cleanText(discussion.message),
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
      .sort(
        (a, b) =>
          Date.parse(b.modified || b.created || '0') -
          Date.parse(a.modified || a.created || '0')
      )
      .slice(0, limit);

    return discussions.length > 0
      ? jsonResult(discussions)
      : textResult('No announcements were found for this course.');
  }

  private async getPendingAssignments(args: any = {}) {
    const userId = await this.deps.getUserId();
    const courseIds = await this.getCourseIds(args);
    const assignments = await this.fetchAssignments(courseIds);

    const statuses = await Promise.all(
      assignments.map(async (assignment: any) => {
        const response = await this.client.get('', {
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

    return pending.length > 0
      ? jsonResult(pending)
      : textResult('There are no pending assignments to submit.');
  }

  private async getMySubmissionStatus(args: any) {
    if (!args?.assignmentId) {
      throw new McpError(ErrorCode.InvalidParams, 'Assignment ID is required');
    }

    const userId = await this.deps.getUserId();

    console.error(`[API] Requesting submission status for assignment ${args.assignmentId}`);

    const response = await this.client.get('', {
      params: {
        wsfunction: 'mod_assign_get_submission_status',
        assignid: args.assignmentId,
        userid: userId,
      },
    });

    const lastAttempt = response.data.lastattempt || {};
    const submission = lastAttempt.submission || {};
    const feedback = response.data.feedback || {};

    return jsonResult({
      assignmentId: args.assignmentId,
      status: submission.status || 'new',
      gradingStatus: lastAttempt.gradingstatus || 'notgraded',
      submitted: submission.status === 'submitted',
      timemodified: submission.timemodified
        ? new Date(submission.timemodified * 1000).toISOString()
        : 'Not submitted',
      grade: feedback.grade?.grade ?? 'Not graded',
      gradeForDisplay: feedback.gradefordisplay || null,
      feedback:
        feedback.plugins
          ?.flatMap((plugin: any) => plugin.editorfields || [])
          .map((field: any) => field.text)
          .filter(Boolean) || [],
    });
  }

  private async getQuizzes(args: any = {}) {
    const courseIds = await this.getCourseIds(args);

    if (courseIds.length === 0) {
      return jsonResult([]);
    }

    console.error(`[API] Requesting quizzes for courses ${courseIds.join(', ')}`);

    const response = await this.client.get('', {
      params: {
        wsfunction: 'mod_quiz_get_quizzes_by_courses',
        courseids: courseIds,
      },
    });

    return jsonResult(response.data.quizzes || []);
  }

  private async getMyQuizGrade(args: any) {
    if (!args?.quizId) {
      throw new McpError(ErrorCode.InvalidParams, 'Quiz ID is required');
    }

    const userId = await this.deps.getUserId();

    console.error(`[API] Requesting quiz grade for quiz ${args.quizId}`);

    const response = await this.client.get('', {
      params: {
        wsfunction: 'mod_quiz_get_user_best_grade',
        quizid: args.quizId,
        userid: userId,
      },
    });

    return jsonResult({
      quizId: args.quizId,
      hasGrade: response.data.hasgrade,
      grade: response.data.hasgrade ? response.data.grade : 'Not graded',
    });
  }

  private async getLectureSchedule(args: any = {}) {
    const courseIds = await this.getCourseIds(args);
    const daysAhead = Math.min(positiveIntegerArg(args, 'daysAhead', 120), 366);
    const now = Math.floor(Date.now() / 1000);
    const timeEnd = now + daysAhead * 24 * 60 * 60;

    if (courseIds.length === 0) {
      return jsonResult([]);
    }

    console.error(
      `[API] Requesting calendar events for courses ${courseIds.join(', ')} over ${daysAhead} days`
    );

    const response = await this.client.get('', {
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
        description: cleanText(event.description),
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

    return events.length > 0
      ? jsonResult(events)
      : textResult(`No course calendar events were found in the next ${daysAhead} days.`);
  }
}
