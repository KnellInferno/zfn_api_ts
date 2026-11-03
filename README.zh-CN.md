# 新正方教务系统 REST API（TypeScript）

这是基于 [openschoolcn/zfn_api](https://github.com/openschoolcn/zfn_api) 重写的 TypeScript 服务。项目对外提供 REST API；正方系统原有页面地址及拼音表单字段封装在内部适配层中，对外路由、参数和 JSON 字段使用清晰的英文名称。项目沿用上游 MPL-2.0 许可证，详见 [LICENSE](./LICENSE)。

## 技术栈

- TypeScript、Node.js 20.10+
- Express 4：REST API 服务
- Cheerio：解析正方系统返回的 HTML
- Node.js 原生 fetch 和 crypto：上游 HTTP 请求与 RSA 密码加密
- 进程内存：保存 API 登录会话与验证码挑战

接口定义见 [OpenAPI 3.1 文件](./openapi.yaml)。

## 安装与启动

复制环境变量示例文件并设置正方教务系统地址：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，至少配置 `ZF_BASE_URL`，然后安装依赖并启动开发服务：

```sh
npm install
npm run dev
```

默认监听端口为 `3000`，可通过 `PORT` 修改。生产构建命令为 `npm run build`，构建后使用 `npm start` 启动。

可配置项：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | API 服务监听端口 |
| `ZF_BASE_URL` | 无 | 正方教务系统根地址，非本机地址须使用 HTTPS |
| `ZF_TIMEOUT_MS` | `8000` | 单次上游请求超时时间（毫秒） |
| `API_SESSION_TTL_MINUTES` | `240` | API 会话有效期（分钟） |

## 登录与认证

创建登录会话：

```http
POST /api/v1/sessions
Content-Type: application/json

{
  "username": "学号",
  "password": "密码"
}
```

登录成功时返回 `201 Created`，响应中的 `data.accessToken` 是后续请求使用的 Bearer Token：

```json
{
  "data": {
    "accessToken": "...",
    "tokenType": "Bearer",
    "expiresAt": "2026-11-02T12:00:00.000Z"
  }
}
```

如果学校要求验证码，登录接口返回 `202 Accepted`，其中 `image` 是 Base64 编码的验证码图片：

```json
{
  "data": {
    "challengeId": "...",
    "image": "...",
    "mediaType": "image/png",
    "expiresAt": "..."
  }
}
```

提交验证码完成登录：

```http
POST /api/v1/sessions/captcha
Content-Type: application/json

{
  "challengeId": "上一步返回的 challengeId",
  "code": "验证码内容"
}
```

除健康检查、创建会话和验证码提交外，其他接口均需在请求头中提供：

```http
Authorization: Bearer <accessToken>
```

注销当前 API 会话：`DELETE /api/v1/sessions/current`。验证码挑战有效期为 5 分钟；API 会话默认有效期为 4 小时。

## REST 资源

所有 JSON 路由位于 `/api/v1` 下。学年参数使用 `academicYear`；学期参数 `term` 的取值为 `1`（上学期）或 `2`（下学期）。成绩和考试查询可省略学期以查询全年；课表及选课查询需要指定学期。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 服务健康状态 |
| POST | `/sessions` | 使用学号和密码登录 |
| POST | `/sessions/captcha` | 提交验证码完成登录 |
| DELETE | `/sessions/current` | 注销当前 API 会话 |
| GET | `/students/me` | 当前登录学生资料 |
| GET | `/grades?academicYear=2024&term=1` | 查询成绩；全年查询可省略 `term` |
| GET | `/exams?academicYear=2024&term=1` | 查询考试安排；全年查询可省略 `term` |
| GET | `/course-schedules?academicYear=2024&term=1` | 查询学期课表 |
| GET | `/course-schedules/pdf?academicYear=2024&term=1` | 下载课表 PDF |
| GET | `/academic-record` | 查询学业进度与课程要求 |
| GET | `/academic-record/pdf` | 下载学业成绩总表 PDF |
| GET | `/notifications` | 查询通知消息 |
| GET | `/grade-point-average` | 查询 GPA |
| GET | `/course-enrollments?academicYear=2024&term=1` | 查询已选课程 |
| GET | `/course-enrollments/available?academicYear=2024&term=1&block=1` | 查询指定选课板块的可选课程 |
| POST | `/course-enrollments` | 选课 |
| DELETE | `/course-enrollments/:courseId?executionId=...&academicYear=2024&term=1` | 退课 |

### 成绩来源参数

`GET /grades` 支持可选参数 `source`：

- `standard`：默认成绩查询接口
- `personal`：使用个人信息页面对应的成绩查询接口，部分学校需要此模式

### 选课请求示例

查询可选课程后，使用返回的英文属性提交选课：

```http
POST /api/v1/course-enrollments
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "courseId": "课程编号",
  "executionId": "教学班执行编号",
  "blockCode": "选课板块编号",
  "academicYear": 2024,
  "term": 1
}
```

退课需提供课程编号、执行编号、学年和学期。例如：

```http
DELETE /api/v1/course-enrollments/COURSE-001?executionId=CLASS-001&academicYear=2024&term=1
Authorization: Bearer <accessToken>
```

退课接口会直接调用教务系统操作，可能绕过部分前端资格校验。调用前请确认该课程允许退选。

## 响应格式

成功的 JSON 响应统一使用 `data` 包装，例如：

```json
{ "data": { "studentId": "...", "fullName": "..." } }
```

错误使用 `application/problem+json`，包含 `type`、`title`、HTTP 状态码 `status`、机器可读错误标识 `code`、说明 `detail` 和请求路径 `instance`。PDF 接口直接返回 `application/pdf` 文件。

主要 HTTP 状态包括：`400` 请求参数无效、`401` 未认证或上游登录过期、`404` 路由不存在、`410` 验证码挑战失效、`422` 上游无法完成当前操作、`502` 上游错误、`504` 上游超时。

### 旧项目自定义状态码的处理

旧 Python 项目用自定义数字 `code` 表示验证码、登录失败、上游超时等业务结果。本 TypeScript 项目不再返回这些数字，而是使用 HTTP 状态码表达请求结果，并在 `application/problem+json` 的字符串 `code` 字段中提供稳定错误标识。查询无数据属于正常结果，不作为错误处理。

| 旧状态码 | 旧含义 | 本项目的处理逻辑 |
| --- | --- | --- |
| `998` | 上游网页弹窗或未处理的提示内容 | 可识别的账号密码错误和验证码错误分别映射为 `401 invalid_credentials`、`400 invalid_captcha`；其他登录提示映射为 `422 login_rejected`。课表 PDF 错误页映射为 `422 pdf_export_failed`；学业成绩总表 PDF 无效则返回 `502 pdf_export_failed`。其他页面提示需在对应解析逻辑中显式识别。 |
| `999` | 未知异常或未覆盖的逻辑错误 | 未识别的服务端异常返回 `500 internal_error`；已识别的故障优先返回更具体的错误码。 |
| `1000` | 操作成功 | 使用 `2xx` HTTP 状态码；JSON 数据放入 `data`，PDF 接口直接返回 PDF 文件内容。 |
| `1001` | 登录需要验证码 | `POST /api/v1/sessions` 返回 `202 Accepted`，并提供 `challengeId` 和 Base64 图片；用户将验证码提交到 `POST /api/v1/sessions/captcha`。 |
| `1002` | 用户名或密码错误 | 返回 `401 Unauthorized`，错误标识为 `invalid_credentials`。 |
| `1003` | 上游请求超时 | 返回 `504 Gateway Timeout`，错误标识为 `upstream_timeout`。 |
| `1004` | 验证码错误 | 返回 `400 Bad Request`，错误标识为 `invalid_captcha`。挑战在 5 分钟有效期内仍可重试。 |
| `1005` | 查询内容为空 | 列表查询返回 `200 OK` 和空集合（资源包含数量字段时 `count: 0`），不把“没有记录”当作系统错误。 |
| `1006` | 上游 Cookie 失效或过期 | 识别到正方登录页时返回 `401 Unauthorized`，错误标识为 `session_expired`；客户端应重新创建登录会话。 |
| `1007` | 上游接口失效，需要更新 | 本项目没有专用的 `1007` 状态。上游 JSON 无法解析时返回 `502 invalid_upstream_response`；检测到登录页或公钥字段变化时分别返回 `502 login_page_changed` 或 `502 login_key_unavailable`。 |
| `2333` | 上游维护、服务被封禁或多次请求失败 | 本项目没有专用的维护/封禁状态码。网络不可达和上游非成功 HTTP 响应分别返回 `502 upstream_unavailable`、`502 upstream_error`；超时返回 `504 upstream_timeout`。若维护页面以 HTTP 200 返回，仍需根据具体学校页面增加识别逻辑。 |

旧状态码及其定义见[原项目 README](https://github.com/openschoolcn/zfn_api#状态码)。上表描述本 TypeScript 项目的实际行为，不代表兼容返回旧数字状态码。

## 已知限制

- 会话保存在当前进程内存中。多实例部署或进程重启后，需要接入共享持久化会话存储。
- 上游仓库的空教室查询仍标记为 TODO，原 Python 模块没有对应实现，因此本项目没有空教室查询路由。
- 不同学校的正方系统页面和字段可能存在差异；个人资料接口包含了备用页面解析，但仍可能需要按具体学校调整。
- 不要将教务账号密码、会话 Token 或 `.env` 文件提交到版本库。
