/*
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * Based on openschoolcn/zfn_api: https://github.com/openschoolcn/zfn_api
 */
import express, { type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { ApiError } from "./errors.js";
import { SessionStore, type ApiSession } from "./services/session-store.js";
import { ZhengfangClient, type AcademicQuery } from "./services/zhengfang-client.js";

export interface AppConfig { baseUrl: string; timeoutMs: number; sessionTtlMs: number; }

type AsyncHandler = (request: Request, response: Response, next: NextFunction) => Promise<void>;
const asyncRoute = (handler: AsyncHandler): RequestHandler => (request, response, next) => { void handler(request, response, next).catch(next); };
const success = (data: unknown) => ({ data });
const integer = (value: unknown, label: string): number => {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) throw new ApiError(400, "invalid_parameter", label + " must be an integer.");
  return parsed;
};
const queryText = (value: unknown): string => typeof value === "string" ? value : "";
const academicQuery = (request: Request): AcademicQuery => {
  const academicYear = integer(request.query.academicYear, "academicYear");
  if (academicYear < 1900 || academicYear > 2200) throw new ApiError(400, "invalid_parameter", "academicYear must be a four-digit year.");
  const termValue = request.query.term;
  if (termValue === undefined || termValue === "") return { academicYear };
  const term = integer(termValue, "term");
  if (term !== 1 && term !== 2) throw new ApiError(400, "invalid_parameter", "term must be 1 or 2.");
  return { academicYear, term };
};
const requiredAcademicQuery = (request: Request): AcademicQuery => {
  const query = academicQuery(request);
  if (query.term === undefined) throw new ApiError(400, "invalid_parameter", "term is required for this resource.");
  return query;
};
const validateAcademicYear = (value: unknown): number => {
  const year = integer(value, "academicYear");
  if (year < 1900 || year > 2200) throw new ApiError(400, "invalid_parameter", "academicYear must be a four-digit year.");
  return year;
};
const bearerToken = (request: Request): string | null => {
  const header = request.header("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
};

export function createApp(config: AppConfig, sessions = new SessionStore(config.sessionTtlMs)) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.get("/api/v1/health", (_request, response) => response.json(success({ status: "ok" })));

  app.post("/api/v1/sessions", asyncRoute(async (request, response) => {
    const username = typeof request.body?.username === "string" ? request.body.username.trim() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!username || !password) throw new ApiError(400, "invalid_request", "username and password are required.");
    const client = new ZhengfangClient(config.baseUrl, config.timeoutMs);
    const result = await client.signIn(username, password);
    if (result.kind === "captcha") {
      const challenge = sessions.createChallenge(client, result.challenge);
      response.status(202).json(success({ challengeId: challenge.id, image: result.image, mediaType: "image/png", expiresAt: new Date(challenge.expiresAt).toISOString() }));
      return;
    }
    const session = sessions.create(client);
    response.status(201).json(success({ accessToken: session.token, tokenType: "Bearer", expiresAt: new Date(session.expiresAt).toISOString() }));
  }));

  app.post("/api/v1/sessions/captcha", asyncRoute(async (request, response) => {
    const challengeId = typeof request.body?.challengeId === "string" ? request.body.challengeId : "";
    const code = typeof request.body?.code === "string" ? request.body.code.trim() : "";
    if (!challengeId || !code) throw new ApiError(400, "invalid_request", "challengeId and code are required.");
    const challenge = sessions.getChallenge(challengeId);
    if (!challenge) throw new ApiError(410, "challenge_expired", "The CAPTCHA challenge is missing or has expired.");
    await challenge.client.completeCaptcha(challenge.challenge, code);
    sessions.removeChallenge(challengeId);
    const session = sessions.create(challenge.client);
    response.status(201).json(success({ accessToken: session.token, tokenType: "Bearer", expiresAt: new Date(session.expiresAt).toISOString() }));
  }));

  const authenticate: RequestHandler = (request, response, next) => {
    const token = bearerToken(request);
    if (!token) {
      response.setHeader("WWW-Authenticate", "Bearer");
      next(new ApiError(401, "authentication_required", "Provide an API session using the Bearer authorization scheme."));
      return;
    }
    const session = sessions.get(token);
    if (!session) {
      response.setHeader("WWW-Authenticate", "Bearer");
      next(new ApiError(401, "session_expired", "The API session is invalid or has expired."));
      return;
    }
    response.locals.apiSession = session;
    response.locals.apiToken = token;
    next();
  };
  const currentSession = (response: Response): ApiSession => response.locals.apiSession as ApiSession;

  app.delete("/api/v1/sessions/current", authenticate, (request, response) => {
    sessions.revoke(String(response.locals.apiToken));
    response.status(204).end();
  });

  app.get("/api/v1/students/me", authenticate, asyncRoute(async (_request, response) => {
    response.json(success(await currentSession(response).client.getProfile()));
  }));
  app.get("/api/v1/grades", authenticate, asyncRoute(async (request, response) => {
    const personalInfo = request.query.source === "personal";
    if (request.query.source !== undefined && request.query.source !== "personal" && request.query.source !== "standard") {
      throw new ApiError(400, "invalid_parameter", "source must be personal or standard.");
    }
    response.json(success(await currentSession(response).client.getGrades(academicQuery(request), personalInfo)));
  }));
  app.get("/api/v1/exams", authenticate, asyncRoute(async (request, response) => {
    response.json(success(await currentSession(response).client.getExams(academicQuery(request))));
  }));
  app.get("/api/v1/course-schedules", authenticate, asyncRoute(async (request, response) => {
    response.json(success(await currentSession(response).client.getCourseSchedule(requiredAcademicQuery(request))));
  }));
  app.get("/api/v1/course-schedules/pdf", authenticate, asyncRoute(async (request, response) => {
    const pdf = await currentSession(response).client.getCourseSchedulePdf(requiredAcademicQuery(request), queryText(request.query.name) || "Export");
    response.type("application/pdf").attachment("course-schedule.pdf").send(pdf);
  }));
  app.get("/api/v1/academic-record", authenticate, asyncRoute(async (_request, response) => {
    response.json(success(await currentSession(response).client.getAcademicRecord()));
  }));
  app.get("/api/v1/academic-record/pdf", authenticate, asyncRoute(async (_request, response) => {
    const pdf = await currentSession(response).client.getAcademicRecordPdf();
    response.type("application/pdf").attachment("academic-record.pdf").send(pdf);
  }));
  app.get("/api/v1/notifications", authenticate, asyncRoute(async (_request, response) => {
    response.json(success(await currentSession(response).client.getNotifications()));
  }));
  app.get("/api/v1/grade-point-average", authenticate, asyncRoute(async (_request, response) => {
    response.json(success({ gradePointAverage: await currentSession(response).client.getGpa() }));
  }));
  app.get("/api/v1/course-enrollments", authenticate, asyncRoute(async (request, response) => {
    response.json(success(await currentSession(response).client.getEnrolledCourses(requiredAcademicQuery(request))));
  }));
  app.get("/api/v1/course-enrollments/available", authenticate, asyncRoute(async (request, response) => {
    const query = academicQuery(request);
    if (query.term === undefined) throw new ApiError(400, "invalid_parameter", "term is required for course enrollment.");
    const block = integer(request.query.block, "block");
    if (block < 1 || block > 3) throw new ApiError(400, "invalid_parameter", "block must be 1, 2, or 3.");
    response.json(success(await currentSession(response).client.getAvailableCourses(query, block)));
  }));
  app.post("/api/v1/course-enrollments", authenticate, asyncRoute(async (request, response) => {
    const courseId = typeof request.body?.courseId === "string" ? request.body.courseId : "";
    const executionId = typeof request.body?.executionId === "string" ? request.body.executionId : "";
    const blockCode = typeof request.body?.blockCode === "string" ? request.body.blockCode : "";
    const academicYear = validateAcademicYear(request.body?.academicYear);
    const term = integer(request.body?.term, "term");
    if (!courseId || !executionId || !blockCode) throw new ApiError(400, "invalid_request", "courseId, executionId, and blockCode are required.");
    if (term !== 1 && term !== 2) throw new ApiError(400, "invalid_parameter", "term must be 1 or 2.");
    const profile = await currentSession(response).client.getProfile();
    const studentId = typeof profile.studentId === "string" ? profile.studentId : "";
    if (!studentId) throw new ApiError(422, "student_id_unavailable", "The student ID is unavailable for this account.");
    const result = await currentSession(response).client.enroll({ studentId, courseId, executionId, blockCode, academicYear, term });
    response.status(201).json(success(result));
  }));
  app.delete("/api/v1/course-enrollments/:courseId", authenticate, asyncRoute(async (request, response) => {
    const courseId = String(request.params.courseId ?? "");
    const executionId = queryText(request.query.executionId);
    const academicYear = validateAcademicYear(request.query.academicYear);
    const term = integer(request.query.term, "term");
    if (!courseId || !executionId) throw new ApiError(400, "invalid_request", "courseId and executionId are required.");
    if (term !== 1 && term !== 2) throw new ApiError(400, "invalid_parameter", "term must be 1 or 2.");
    response.json(success(await currentSession(response).client.withdraw({ courseId, executionId, academicYear, term })));
  }));

  app.use((_request, _response, next) => next(new ApiError(404, "not_found", "The requested API resource does not exist.")));
  const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
    if (response.headersSent) return;
    const apiError = error instanceof ApiError
      ? error
      : error instanceof SyntaxError
        ? new ApiError(400, "invalid_json", "The request body must contain valid JSON.")
        : new ApiError(500, "internal_error", "An unexpected server error occurred.");
    const titles: Record<number, string> = {
      400: "Bad Request",
      401: "Unauthorized",
      404: "Not Found",
      410: "Gone",
      422: "Unprocessable Content",
      500: "Internal Server Error",
      502: "Bad Gateway",
      504: "Gateway Timeout"
    };
    response.status(apiError.status).type("application/problem+json").json({
      type: "about:blank",
      title: titles[apiError.status] ?? "Request Failed",
      status: apiError.status,
      code: apiError.code,
      detail: apiError.message,
      instance: request.path
    });
  };
  app.use(errorHandler);
  return { app, sessions };
}
