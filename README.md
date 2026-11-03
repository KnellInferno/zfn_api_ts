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

### Legacy status-code behavior

The Python source documents custom result codes for outcomes such as CAPTCHA prompts, expired cookies, and upstream errors. This TypeScript API does not return those numbers. It expresses the same business outcomes with HTTP status codes and a stable string `code` in `application/problem+json`; normal empty search results remain successful responses.

| Legacy code | Legacy meaning | TypeScript API behavior |
| --- | --- | --- |
| `998` | An upstream page contains an unhandled popup/message | Recognized invalid credentials and CAPTCHA errors become `401 invalid_credentials` and `400 invalid_captcha`; other login prompts become `422 login_rejected`. A course-schedule PDF error page becomes `422 pdf_export_failed`; an invalid academic-record PDF becomes `502 pdf_export_failed`. Other page-specific messages need explicit handling in the adapter. |
| `999` | Unknown or unexpected logic error | Unhandled server errors become `500 internal_error`. Errors recognized by the adapter use a more specific code. |
| `1000` | Operation succeeded | Return the resource with a `2xx` HTTP status. JSON is wrapped in `data`; PDF endpoints return the PDF bytes. |
| `1001` | CAPTCHA required | `POST /sessions` returns `202 Accepted` with `challengeId` and the Base64 image. Submit the answer to `POST /sessions/captcha`. |
| `1002` | Username or password is incorrect | Return `401 Unauthorized` with `code: "invalid_credentials"`. |
| `1003` | Upstream request timed out | Return `504 Gateway Timeout` with `code: "upstream_timeout"`. |
| `1004` | CAPTCHA answer is incorrect | Return `400 Bad Request` with `code: "invalid_captcha"`. The challenge can be retried until it expires after five minutes. |
| `1005` | Requested content is empty | Collection queries return `200 OK` with an empty collection (and `count: 0` where that resource includes a count); an empty result is not treated as an error. |
| `1006` | Upstream cookies are invalid or expired | A returned login page becomes `401 Unauthorized` with `code: "session_expired"`; create a new API session by signing in again. |
| `1007` | Upstream interface may have changed and needs updating | There is no dedicated `1007` equivalent. Unreadable upstream JSON becomes `502 invalid_upstream_response`; recognized login-page or missing-key changes use specific `502` errors such as `login_page_changed` or `login_key_unavailable`. |
| `2333` | Upstream maintenance, blocking, or repeated request failure | There is no dedicated maintenance/ban code. Network failures and non-success upstream HTTP responses become `502 upstream_unavailable` or `502 upstream_error`; timeouts remain `504 upstream_timeout`. A maintenance page returned with HTTP 200 may need school-specific detection. |

The legacy codes and their meanings are listed in the [upstream README](https://github.com/openschoolcn/zfn_api#状态码). The behavior above describes this TypeScript implementation, not a numeric-code compatibility mode.

No school credentials or API tokens should be committed to source control. The built-in in-memory session store is intended for a single-process deployment.
