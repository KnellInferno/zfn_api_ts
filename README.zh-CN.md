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

## 已知限制

- 会话保存在当前进程内存中。多实例部署或进程重启后，需要接入共享持久化会话存储。
- 上游仓库的空教室查询仍标记为 TODO，原 Python 模块没有对应实现，因此本项目没有空教室查询路由。
- 不同学校的正方系统页面和字段可能存在差异；个人资料接口包含了备用页面解析，但仍可能需要按具体学校调整。
- 不要将教务账号密码、会话 Token 或 `.env` 文件提交到版本库。
