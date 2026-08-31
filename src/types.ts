export interface Course {
  id: number;
  shortname: string;
  fullname: string;
  startdate: number;
  enddate: number;
  progress?: number;
}

export interface Assignment {
  id: number;
  name: string;
  duedate: number;
  allowsubmissionsfromdate: number;
  grade: number;
  timemodified: number;
  cutoffdate: number;
}

export interface CourseModule {
  id: number;
  name: string;
  modname: string;
  modplural?: string;
  instance?: number;
  url?: string;
  description?: string;
  visible?: number;
  uservisible?: boolean;
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

export interface CourseSection {
  id: number;
  name?: string;
  summary?: string;
  section: number;
  modules?: CourseModule[];
}

