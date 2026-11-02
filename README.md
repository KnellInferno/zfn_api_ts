# Zhengfang REST API (TypeScript)

A TypeScript REST service that adapts the Zhengfang academic system. Based on [openschoolcn/zfn_api](https://github.com/openschoolcn/zfn_api) and licensed under MPL-2.0. The upstream system uses legacy form fields and page URLs; those details stay inside the adapter. Public routes, request fields, and response fields use clear English names.

中文说明： [README.zh-CN.md](./README.zh-CN.md)。

## Features

- Login with automatic CAPTCHA detection and a separate CAPTCHA completion step
- Student profile and GPA
- Grades, exam schedules, and weekly course schedules
- Course schedule PDF export
- Academic progress and notifications
- Selected and available courses, enrollment, and withdrawal

## Start

Requires Node.js 20.10+. Configure `ZF_BASE_URL` in the environment (copy `.env.example` as a starting point), then install dependencies and run:

```sh
npm install
npm run dev
```

The service listens on `PORT` (default `3000`). API routes are under `/api/v1`. Sessions are held in memory, so use a persistent session store before running multiple replicas or relying on long-lived sessions. Configure the upstream URL only for a Zhengfang instance you are authorized to access.

## Authentication

Create a session with account credentials:

```http
POST /api/v1/sessions
Content-Type: application/json

{ "username": "student-id", "password": "secret" }
```

A direct login responds with `201 Created` and `data.accessToken`. If the school requires a CAPTCHA, the response is `202 Accepted` with a short-lived `challengeId` and base64 `image`. Complete it using `POST /api/v1/sessions/captcha` with `challengeId` and `code`. Send the resulting access token as `Authorization: Bearer <token>`.

Use `DELETE /api/v1/sessions/current` to revoke the active API session.

## REST resources

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/health` | Service status |
| POST | `/api/v1/sessions` | Sign in |
| POST | `/api/v1/sessions/captcha` | Complete CAPTCHA sign-in |
| DELETE | `/api/v1/sessions/current` | Revoke the current session |
| GET | `/api/v1/students/me` | Current student profile |
| GET | `/api/v1/grades?academicYear=2024&term=1` | Grades (omit term for the whole year) |
| GET | `/api/v1/exams?academicYear=2024&term=1` | Exam schedule |
| GET | `/api/v1/course-schedules?academicYear=2024&term=1` | Course schedule |
| GET | `/api/v1/course-schedules/pdf?academicYear=2024&term=1` | Download course schedule PDF |
| GET | `/api/v1/academic-record/pdf` | Download academic record PDF |
| GET | `/api/v1/academic-record` | Academic progress and course requirements |
| GET | `/api/v1/notifications` | Student notifications |
| GET | `/api/v1/grade-point-average` | GPA summary |
| GET | `/api/v1/course-enrollments?academicYear=2024&term=1` | Enrolled courses |
| GET | `/api/v1/course-enrollments/available?academicYear=2024&term=1&block=1` | Courses available in a block |
| POST | `/api/v1/course-enrollments` | Enroll in a class |
| DELETE | `/api/v1/course-enrollments/:courseId?executionId=...&academicYear=2024&term=1` | Withdraw from a class |

The OpenAPI 3.1 contract is in `openapi.yaml`.

The source repository marks vacant classroom lookup as TODO and does not include an upstream implementation, so this API does not expose a classroom availability route.

Academic terms are `1` (first term), `2` (second term), or omitted where the upstream operation supports a full-year query. Enrollment and withdrawal requests mutate the school system immediately.

## Response format

JSON success responses are wrapped in `data`. Errors use a stable problem object with `type`, `title`, `status`, `code`, and `detail`. PDF responses use `application/pdf`.

No school credentials or API tokens should be committed to source control. The built-in in-memory session store is intended for a single-process deployment.
