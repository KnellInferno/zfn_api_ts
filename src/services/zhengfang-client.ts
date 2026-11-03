/*
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * Based on openschoolcn/zfn_api: https://github.com/openschoolcn/zfn_api
 */
import { constants, createPublicKey, publicEncrypt } from "node:crypto";
import { load } from "cheerio";
import { ApiError } from "../errors.js";

type RequestMethod = "GET" | "POST";
type FormData = Record<string, string | number | boolean | undefined>;
interface RequestOptions { method?: RequestMethod | undefined; form?: FormData | undefined; query?: FormData | undefined; allowUnauthenticated?: boolean | undefined; }
interface ResponseData { status: number; text: string; bytes: Buffer; contentType: string; }
export interface LoginChallenge { username: string; password: string; csrfToken: string; modulus: string; exponent: string; }
export type LoginResult = { kind: "authenticated" } | { kind: "captcha"; image: string; challenge: LoginChallenge };
export interface AcademicQuery { academicYear: number; term?: number; }

const DEFAULT_CLASS_TIMES = [
  ["8:00", "8:40"], ["8:45", "9:25"], ["9:30", "10:10"],
  ["10:30", "11:10"], ["11:15", "11:55"], ["14:30", "15:10"],
  ["15:15", "15:55"], ["16:05", "16:45"], ["16:50", "17:30"],
  ["18:40", "19:20"], ["19:25", "20:05"], ["20:10", "20:50"],
  ["20:55", "21:35"]
];

const asRecord = (value: unknown): Record<string, any> => value && typeof value === "object" ? value as Record<string, any> : {};
const asList = (value: unknown): any[] => Array.isArray(value) ? value : [];
const parseNumber = (value: unknown): number | string | null => {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value);
  if (!/^\d+$/.test(raw)) return raw;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : raw;
};
const parseDecimal = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  if (value === "无") return 0;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? Number(parsed.toFixed(1)) : null;
};
const textValue = (value: unknown): string | null => value === null || value === undefined || value === "" ? null : String(value);
// Zhengfang encodes terms as 3 (term 1), 12 (term 2), and an empty string for a full-year query.
const academicTermCode = (term?: number): string => term ? String(term * term * 3) : "";
const valuesIn = (value: unknown): number[] => String(value ?? "").match(/\d+/g)?.map(Number) ?? [];
const formatSessions = (value: unknown): number[] | null => {
  const values = valuesIn(value);
  if (values.length < 2) return null;
  return Array.from({ length: Math.max(0, values[1]! - values[0]! + 1) }, (_, index) => values[0]! + index);
};
const formatWeeks = (value: unknown): number[] | null => {
  if (value === null || value === undefined || value === "") return null;
  const result: number[] = [];
  for (const part of String(value).split(",")) {
    const numbers = valuesIn(part);
    if (numbers.length === 1) result.push(numbers[0]!);
    if (numbers.length >= 2) {
      for (let week = numbers[0]!; week <= numbers[1]!; week++) {
        if (part.includes("单") && week % 2 === 0) continue;
        if (part.includes("双") && week % 2 !== 0) continue;
        result.push(week);
      }
    }
  }
  return result;
};

export class ZhengfangClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly cookies = new Map<string, string>();
  private readonly referer: string;

  constructor(baseUrl: string, timeoutMs: number, initialCookies: Record<string, string> = {}) {
    try { this.baseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"); }
    catch { throw new ApiError(500, "invalid_configuration", "ZF_BASE_URL must be a valid absolute URL."); }
    if (this.baseUrl.protocol !== "https:" && this.baseUrl.hostname !== "localhost" && this.baseUrl.hostname !== "127.0.0.1") {
      throw new ApiError(500, "invalid_configuration", "ZF_BASE_URL must use HTTPS outside localhost.");
    }
    this.timeoutMs = timeoutMs;
    for (const [name, value] of Object.entries(initialCookies)) this.cookies.set(name, value);
    this.referer = new URL("xtgl/login_slogin.html", this.baseUrl).toString();
  }

  private cookieHeader(): string { return [...this.cookies].map(([name, value]) => name + "=" + value).join("; "); }

  // Preserve cookies across the multi-request login flow and later API calls, as a browser session would.
  private captureCookies(headers: Headers): void {
    const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const cookieLines = getSetCookie ? getSetCookie.call(headers) : [headers.get("set-cookie") ?? ""];
    for (const line of cookieLines) {
      const first = line.split(";")[0];
      const separator = first?.indexOf("=") ?? -1;
      if (separator > 0) this.cookies.set(first!.slice(0, separator).trim(), first!.slice(separator + 1).trim());
    }
  }

  private async request(path: string, options: RequestOptions = {}): Promise<ResponseData> {
    let url: URL;
    try { url = new URL(path, this.baseUrl); }
    catch { throw new ApiError(502, "invalid_upstream_url", "The academic system returned an invalid resource URL."); }
    if (url.origin !== this.baseUrl.origin) throw new ApiError(502, "unsafe_upstream_redirect", "The academic system referenced an unexpected host.");
    if (options.query) for (const [key, value] of Object.entries(options.query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers = new Headers({
      Accept: "application/json, text/html, application/pdf, */*;q=0.8",
      Referer: this.referer,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"
    });
    const cookie = this.cookieHeader();
    if (cookie) headers.set("Cookie", cookie);
    let body: string | undefined;
    if (options.form) {
      // The upstream still expects URL-encoded forms and legacy field names; keep that protocol at this boundary.
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(options.form)) if (value !== undefined) form.set(key, String(value));
      body = form.toString();
      headers.set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
    }
    let response: Response | undefined;
    let currentUrl = url;
    let method = options.method ?? "GET";
    let requestBody = body;
    try {
      // Follow only same-origin redirects so session cookies are never sent to another host.
      for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
        const cookieHeader = this.cookieHeader();
        if (cookieHeader) headers.set("Cookie", cookieHeader);
        response = await fetch(currentUrl, { method, headers, body: requestBody, signal: AbortSignal.timeout(this.timeoutMs), redirect: "manual" });
        this.captureCookies(response.headers);
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get("location");
        if (!location) break;
        if (redirectCount === 5) throw new ApiError(502, "upstream_redirect_limit", "The academic system redirected too many times.");
        currentUrl = new URL(location, currentUrl);
        if (currentUrl.origin !== this.baseUrl.origin) throw new ApiError(502, "unsafe_upstream_redirect", "The academic system redirected to an unexpected host.");
        if ([301, 302, 303].includes(response.status) && method === "POST") { method = "GET"; requestBody = undefined; headers.delete("Content-Type"); }
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new ApiError(504, "upstream_timeout", "The academic system did not respond in time.");
      }
      throw new ApiError(502, "upstream_unavailable", "The academic system could not be reached.");
    }
    if (!response) throw new ApiError(502, "upstream_unavailable", "The academic system returned no response.");
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString("utf8");
    if (!response.ok) throw new ApiError(502, "upstream_error", "The academic system returned HTTP " + response.status + ".");
    // Zhengfang often signals expired cookies by returning its login HTML with HTTP 200.
    if (!options.allowUnauthenticated && this.isLoginPage(text)) throw new ApiError(401, "session_expired", "The academic system session has expired. Sign in again.");
    return { status: response.status, text, bytes, contentType: response.headers.get("content-type") ?? "" };
  }

  private isLoginPage(html: string): boolean {
    if (!html.trimStart().startsWith("<") && !html.includes("<html")) return false;
    const $ = load(html);
    return $("h5").first().text().trim() === "用户登录" || $("#csrftoken").length > 0 && $("input#yhm").length > 0;
  }

  private async json(path: string, form?: FormData): Promise<any> {
    const response = await this.request(path, { method: form ? "POST" : "GET", form });
    try { return JSON.parse(response.text); }
    catch { throw new ApiError(502, "invalid_upstream_response", "The academic system returned an unreadable response."); }
  }

  private async postJson(path: string, form: FormData): Promise<any> { return this.json(path, form); }

  private explainLoginError(html: string): never | void {
    const $ = load(html);
    const tip = $("p#tips").text().trim();
    if (!tip) return;
    // Convert the old login-page messages into stable REST errors instead of exposing numeric legacy codes.
    if (tip.includes("验证码")) throw new ApiError(400, "invalid_captcha", "The CAPTCHA code is incorrect.");
    if (tip.includes("用户名") || tip.includes("密码")) throw new ApiError(401, "invalid_credentials", "The username or password is incorrect.");
    throw new ApiError(422, "login_rejected", tip);
  }

  async signIn(username: string, password: string): Promise<LoginResult> {
    const loginPage = await this.request("xtgl/login_slogin.html", { allowUnauthenticated: true });
    const $ = load(loginPage.text);
    const csrfToken = $("#csrftoken").attr("value");
    if (!csrfToken) throw new ApiError(502, "login_page_changed", "The academic system login page did not contain a CSRF token.");
    const key = asRecord(await this.json("xtgl/login_getPublicKey.html"));
    const modulus = textValue(key.modulus);
    const exponent = textValue(key.exponent);
    if (!modulus || !exponent) throw new ApiError(502, "login_key_unavailable", "The academic system did not provide a password encryption key.");
    // Return a resumable challenge when this deployment requires a CAPTCHA; the credentials remain server-side.
    if ($("input#yzm").length > 0) {
      const image = await this.request("kaptcha", { allowUnauthenticated: true });
      return { kind: "captcha", image: image.bytes.toString("base64"), challenge: { username, password, csrfToken, modulus, exponent } };
    }
    const response = await this.request("xtgl/login_slogin.html", { method: "POST",
       allowUnauthenticated: true,
       form: { csrftoken: csrfToken, yhm: username, mm: this.encryptPassword(password, modulus, exponent) } });
    this.explainLoginError(response.text);
    if (this.isLoginPage(response.text)) throw new ApiError(401, "invalid_credentials", "The academic system did not accept the credentials.");
    return { kind: "authenticated" };
  }

  async completeCaptcha(challenge: LoginChallenge, code: string): Promise<void> {
    const response = await this.request("xtgl/login_slogin.html", { method: "POST",
       allowUnauthenticated: true,
       form: { csrftoken: challenge.csrfToken, yhm: challenge.username, mm: this.encryptPassword(challenge.password, challenge.modulus, challenge.exponent), yzm: code } });
    this.explainLoginError(response.text);
    if (this.isLoginPage(response.text)) throw new ApiError(401, "invalid_credentials", "The academic system did not accept the credentials.");
  }

  private encryptPassword(password: string, modulus: string, exponent: string): string {
    try {
      const base64UrlInteger = (value: string) => {
        const bytes = Buffer.from(value, "base64");
        let offset = 0;
        while (offset < bytes.length - 1 && bytes[offset] === 0) offset++;
        return bytes.subarray(offset).toString("base64url");
      };
      const key = createPublicKey({
        key: { kty: "RSA", n: base64UrlInteger(modulus), e: base64UrlInteger(exponent) },
        format: "jwk"
      });
      return publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(password, "utf8")).toString("base64");
    } catch { throw new ApiError(502, "login_key_invalid", "The academic system provided an invalid password encryption key."); }
  }

  async getProfile(): Promise<Record<string, unknown>> {
    const primary = await this.request("xsxxxggl/xsxxwh_cxCkDgxsxx.html?gnmkdm=N100801");
    let data: Record<string, any> | null = null;
    try { data = asRecord(JSON.parse(primary.text)); } catch { /* Some deployments return the profile form instead. */ }
    if (data && Object.keys(data).length > 0) {
      return { studentId: data.xh ?? null,
         fullName: data.xm ?? null,
         college: data.zsjg_id ?? data.jg_id ?? null,
         major: data.zszyh_id ?? data.zyh_id ?? null,
         className: data.bh_id ?? data.xjztdm ?? null,
         enrollmentStatus: data.xjztdm ?? null,
         enrollmentDate: data.rxrq ?? null,
         candidateNumber: data.ksh ?? null,
         previousSchool: data.byzx ?? null,
         hometown: data.jg ?? null,
         postalCode: data.yzbm ?? null,
         politicalStatus: data.zzmmm ?? null,
         ethnicity: data.mzm ?? null,
         educationLevel: data.pyccdm ?? null,
         phoneNumber: data.sjhm ?? null,
         guardianPhone: data.gddh ?? null,
         email: data.dzyx ?? null,
         birthDate: data.csrq ?? null,
         identityNumber: data.zjhm ?? null };
    }
    const fallback = await this.request("xsxxxggl/xsgrxxwh_cxXsgrxx.html?gnmkdm=N100801");
    return this.parseProfileForm(fallback.text);
  }

  private parseProfileForm(html: string): Record<string, unknown> {
    const $ = load(html);
    const fields: Record<string, string> = {};
    $("div.form-group").each((_, item) => {
      const row = $(item);
      const label = row.find("label.control-label").first().text().trim();
      const value = row.find("p.form-control-static, label.control-label").last().text().trim();
      if (label) fields[label] = value;
    });
    const value = (key: string) => fields[key + "："] ?? fields[key] ?? null;
    if (!value("学号")) throw new ApiError(422, "student_data_unavailable", "The academic system has no student profile for this account.");
    return {
      studentId: value("学号"),
      fullName: value("姓名"),
      college: value("学院名称") ?? value("学院"),
      major: value("专业名称") ?? value("专业"),
      className: value("班级名称") ?? value("班级"),
      enrollmentStatus: value("学籍状态"),
      enrollmentDate: value("入学日期"),
      candidateNumber: value("考生号"),
      previousSchool: value("毕业中学"),
      hometown: value("籍贯"),
      postalCode: value("邮政编码"),
      politicalStatus: value("政治面貌"),
      ethnicity: value("民族"),
      educationLevel: value("培养层次"),
      phoneNumber: value("手机号码"),
      guardianPhone: null,
      email: value("电子邮箱"),
      birthDate: value("出生日期"),
      identityNumber: value("证件号码")
    };
  }

  async getGrades(query: AcademicQuery, usePersonalInfo = false): Promise<Record<string, unknown>> {
    const path = usePersonalInfo
      ? "cjcx/cjcx_cxDgXscj.html?doType=query&gnmkdm=N305005"
      : "cjcx/cjcx_cxXsgrcj.html?doType=query&gnmkdm=N305005";
    const payload = asRecord(await this.postJson(path, { xnm: query.academicYear,
       xqm: academicTermCode(query.term),
       _search: "false",
       nd: Date.now(),
       "queryModel.showCount": 100,
       "queryModel.currentPage": 1,
       "queryModel.sortName": "",
       "queryModel.sortOrder": "asc",
       time: 0 }));
    // An empty result is a valid query outcome, not an upstream failure; expose it as count: 0 and courses: [].
    const courses = asList(payload.items);
    return { academicYear: query.academicYear,
       term: query.term ?? null,
       count: courses.length,
       courses: courses.map((item) => ({ courseId: item.kch_id ?? null,
          title: item.kcmc ?? null,
          teacher: item.jsxm ?? null,
          className: item.jxbmc ?? null,
          credits: parseDecimal(item.xf),
          category: item.kclbmc ?? null,
          courseNature: item.kcxzmc ?? null,
          grade: parseNumber(item.cj),
          gradePoint: parseDecimal(item.jd),
          gradeType: item.ksxz ?? null,
          offeringCollege: item.kkbmmc ?? null,
          mark: item.kcbj ?? null })) };
  }

  async getExams(query: AcademicQuery): Promise<Record<string, unknown>> {
    const payload = asRecord(await this.postJson("kwgl/kscx_cxXsksxxIndex.html?doType=query&gnmkdm=N358105", { xnm: query.academicYear,
       xqm: academicTermCode(query.term),
       _search: "false",
       nd: Date.now(),
       "queryModel.showCount": 100,
       "queryModel.currentPage": 1,
       "queryModel.sortName": "",
       "queryModel.sortOrder": "asc",
       time: 0 }));
    const exams = asList(payload.items);
    return { academicYear: query.academicYear,
       term: query.term ?? null,
       count: exams.length,
       exams: exams.map((item) => ({ courseId: item.kch ?? null,
          title: item.kcmc ?? null,
          startsAt: item.kssj ?? null,
          location: item.cdmc ?? null,
          campus: item.cdxqmc ?? null,
          seat: item.zwh ?? null,
          retake: item.cxbj ?? "",
          examSession: item.ksmc ?? null,
          teacher: item.jsxx ?? null,
          className: item.jxbmc ?? null,
          offeringCollege: item.kkxy ?? null,
          credits: parseDecimal(item.xf),
          examFormat: item.ksfs ?? null,
          paperNumber: item.sjbh ?? null,
          notes: item.bz1 ?? "" })) };
  }

  async getCourseSchedule(query: AcademicQuery): Promise<Record<string, unknown>> {
    const payload = asRecord(await this.postJson("kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151", { xnm: query.academicYear, xqm: academicTermCode(query.term) }));
    const student = asRecord(payload.xsxx);
    // No scheduled courses for a term is represented by an empty collection, matching REST list-resource semantics.
    const rows = asList(payload.kbList);
    const courses = rows.map((item) => {
      const sessionNumbers = valuesIn(item.jc);
      const first = sessionNumbers[0];
      const period = first === undefined ? undefined : DEFAULT_CLASS_TIMES[first + 1];
      const time = period ? period[0] + "~" + period[1] : null;
      return { courseId: item.kch_id ?? null,
         title: item.kcmc ?? null,
         teacher: item.xm ?? null,
         className: item.jxbmc ?? null,
         credits: parseDecimal(item.xf),
         weekday: parseNumber(item.xqj),
         time,
         sessions: textValue(item.jc),
         sessionNumbers: formatSessions(item.jc),
         weeks: textValue(item.zcd),
         weekNumbers: formatWeeks(item.zcd),
         evaluationMode: item.khfsmc ?? null,
         campus: item.xqmc ?? null,
         location: item.cdmc ?? null,
         contactHours: item.kcxszc ?? null,
         weeklyHours: parseNumber(item.zhxs),
         totalHours: parseNumber(item.zxs) };
    });
    return { studentId: student.XH ?? null,
       fullName: student.XM ?? null,
       academicYear: query.academicYear,
       term: query.term ?? null,
       count: courses.length,
       courses,
       extraCourses: asList(payload.sjkList).map((item) => item.qtkcgs ?? null) };
  }

  async getAcademicRecord(): Promise<Record<string, unknown>> {
    const html = (await this.request("xsxy/xsxyqk_cxXsxyqkIndex.html?gnmkdm=N105515&layout=default")).text;
    const $ = load(html);
    const studentId = $("input#xh_id").attr("value") ?? null;
    const display = $("div#alertBox").text().replace(/\s+/g, "");
    const gpaMatch = display.match(/[0-9]+\.[0-9]+/);
    const statistics: Record<string, unknown> = { gpa: gpaMatch ? Number(gpaMatch[0]) : null };
    const summaryMatch = display.match(/计划总课程(\d+)门通过(\d+)门?.*未通过(\d+)门?.*未修(\d+)?.*在读(\d+)门?.*计划外?.*通过(\d+)门?.*未通过(\d+)门/);
    if (summaryMatch) statistics.courseCounts = { planned: { total: Number(summaryMatch[1]),
       passed: Number(summaryMatch[2]),
       failed: Number(summaryMatch[3]),
       unstarted: Number(summaryMatch[4]),
       inProgress: Number(summaryMatch[5]) },
      
       extra: { passed: Number(summaryMatch[6]), failed: Number(summaryMatch[7]) } };
    const groupPattern = /"(.*)&nbsp.*要求学分.*:([0-9]{1,}[.][0-9]*|0|&nbsp;).*获得学分.*:([0-9]{1,}[.][0-9]*|0|&nbsp;).*未获得学分.*:([0-9]{1,}[.][0-9]*|0|&nbsp;)[\s\S]*?<span id='showKc(.*)'><\/span>/g;
    const groups: Array<{ type: string; id: string; credits: Record<string, number | null> }> = [];
    let match: RegExpExecArray | null;
    while ((match = groupPattern.exec(html)) !== null) {
      const type = match[1]!.trim();
      if (type && type.length <= 20 && !groups.some((item) => item.type === type)) groups.push({ type,
         id: match[5]!,
         credits: { required: parseDecimal(match[2]), earned: parseDecimal(match[3]), missing: parseDecimal(match[4]) } });
    }
    const details: unknown[] = [];
    for (const group of groups) {
      const courses = asList(await this.postJson("xsxy/xsxyqk_cxJxzxjhxfyqKcxx.html?gnmkdm=N105515", { xfyqjd_id: group.id }));
      details.push({ type: group.type,
         credits: group.credits,
         courses: courses.map((item) => ({ courseId: item.KCH ?? null,
            title: item.KCMC ?? null,
            completionStatus: parseNumber(item.XDZT),
            termLabel: this.displayTerm(String(studentId ?? ""),
            item.JYXDXNM,
            item.JYXDXQMC),
            credits: parseDecimal(item.XF),
            category: item.KCLBMC ?? null,
            courseNature: item.KCXZMC ?? null,
            bestGrade: parseNumber(item.MAXCJ),
            gradePoint: parseDecimal(item.JD) })) });
    }
    return { studentId, statistics, details };
  }

  private displayTerm(studentId: string, academicYear: unknown, term: unknown): string | null {
    if (!studentId || academicYear === null || academicYear === undefined || term === null || term === undefined) return null;
    const grade = Number.parseInt(studentId.slice(0, 2), 10);
    const year = Number.parseInt(String(academicYear).slice(-2), 10);
    const semester = Number.parseInt(String(term), 10);
    const level = year - grade + 1;
    if (level < 1 || level > 4) return null;
    return "大" + ["一", "二", "三", "四"][level - 1] + (semester === 1 ? "上" : "下");
  }

  async getAcademicRecordPdf(): Promise<Buffer> {
    const data: FormData = { gsdygx: "10628-zw-mrgs",
       ids: "",
       bdykcxzDms: "",
       cytjkcxzDms: "",
       cytjkclbDms: "",
       cytjkcgsDms: "",
       bjgbdykcxzDms: "",
       bjgbdyxxkcxzDms: "",
       djksxmDms: "",
       cjbzmcDms: "",
       cjdySzxs: "",
       wjlx: "pdf" };
    const params = { gnmkdm: "N558020", time: Date.now() };
    await this.request("bysxxcx/xscjzbdy_dyXscjzbView.html", { method: "POST", form: data, query: params });
    await this.request("bysxxcx/xscjzbdy_dyCjdyszxView.html", { method: "POST", form: { xh: "" }, query: { gnmkdm: "N558020" } });
    const policyData = { ...data }; delete policyData.wjlx;
    await this.request("xtgl/bysxxcx/xscjzbdy_cxXsCount.html", { method: "POST", form: policyData, query: { gnmkdm: "N558020" } });
    await this.request("bysxxcx/xscjzbdy_cxGswjlx.html", { method: "POST", form: policyData, query: { gnmkdm: "N558020" } });
    await this.request("common/common_cxJwxtxx.html", { method: "POST", form: { gnmkdm: "N558020" }, query: { gnmkdm: "N558020" } });
    const file = await this.request("bysxxcx/xscjzbdy_dyList.html", { method: "POST", form: data, query: { gnmkdm: "N558020" } });
    const relativePath = file.text.replace("#成功", "").replaceAll(String.fromCharCode(34), "").replaceAll("\\", "/").replaceAll("\", "/").trim();
    const pdf = await this.request(relativePath);
    if (!pdf.contentType.includes("pdf") && !pdf.bytes.subarray(0, 4).equals(Buffer.from("%PDF"))) {
      throw new ApiError(502, "pdf_export_failed", "The academic system did not return a valid PDF.");
    }
    return pdf.bytes;
  }

  async getCourseSchedulePdf(query: AcademicQuery, name = "导出"): Promise<Buffer> {
    const sourceTerm = query.term ?? 0;
    const data: FormData = { xm: name,
       xnm: query.academicYear,
       xqm: academicTermCode(query.term),
       xnmc: query.academicYear + "-" + (query.academicYear + 1),
       xqmmc: sourceTerm,
       jgmc: "undefined",
       xxdm: "",
       "xszd.sj": true,
       "xszd.cd": true,
       "xszd.js": true,
       "xszd.jszc": false,
       "xszd.jxb": true,
       "xszd.xkbz": true,
       "xszd.kcxszc": true,
       "xszd.zhxs": true,
       "xszd.zxs": true,
       "xszd.khfs": true,
       "xszd.xf": true,
       "xszd.skfsmc": false,
       kzlx: "dy" };
    await this.request("kbdy/bjkbdy_cxXnxqsfkz.html", { method: "POST", form: data, query: { gnmkdm: "N2151" } });
    const pdf = await this.request("kbcx/xskbcx_cxXsShcPdf.html", { method: "POST", form: data, query: { doType: "table" } });
    if (!pdf.contentType.includes("pdf") && !pdf.bytes.subarray(0, 4).equals(Buffer.from("%PDF"))) {
      const $ = load(pdf.text); const message = $("p.error_title").text().trim();
      throw new ApiError(422, "pdf_export_failed", message || "The academic system could not generate the schedule PDF.");
    }
    return pdf.bytes;
  }

  async getNotifications(): Promise<Record<string, unknown>[]> {
    const payload = asRecord(await this.postJson("xtgl/index_cxDbsy.html?doType=query", { sfyy: 0,
       flag: 1,
       _search: "false",
       nd: Date.now(),
       "queryModel.showCount": 1000,
       "queryModel.currentPage": 1,
       "queryModel.sortName": "cjsj",
       "queryModel.sortOrder": "desc",
       time: 0 }));
    return asList(payload.items).map((item) => {
      const content = String(item.xxnr ?? ""); const separator = content.indexOf(":");
      return { type: separator < 0 ? null : content.slice(0, separator), content: separator < 0 ? content || null : content.slice(separator + 1), createdAt: item.cjsj ?? null };
    });
  }

  async getEnrolledCourses(query: AcademicQuery): Promise<Record<string, unknown>> {
    const rows = asList(await this.postJson("xsxk/zzxkyzb_cxZzxkYzbChoosedDisplay.html?gnmkdm=N253512", { xkxnm: query.academicYear, xkxqm: academicTermCode(query.term) }));
    return { academicYear: query.academicYear, term: query.term ?? null, count: rows.length, courses: rows.map((item) => {
      const teacherParts = String(item.jsxx ?? "").match(/(.*?\d+)\/(.*?)\//);
      return { courseId: item.kch ?? null,
         classId: item.jxb_id ?? null,
         executionId: item.do_jxb_id ?? null,
         title: item.kcmc ?? null,
         teacherId: teacherParts?.[1] ?? null,
         teacher: teacherParts?.[2] ?? null,
         credits: parseDecimal(item.xf),
         category: item.kklxmc ?? null,
         capacity: Number(item.jxbrs ?? 0),
         enrollmentCount: Number(item.yxzrs ?? 0),
         location: this.getPlace(item.jxdd),
         meetingTime: this.getCourseTime(item.sksj),
         optional: Boolean(Number(item.zixf ?? 0)),
         waitlisted: item.sxbj ?? null };
    }) };
  }

  async getAvailableCourses(query: AcademicQuery, block: number): Promise<Record<string, unknown>> {
    const html = (await this.request("xsxk/zzxkyzb_cxZzxkYzbIndex.html?gnmkdm=N253512&layout=default")).text;
    const $ = load(html);
    const tabs = $("a[role='tab']").toArray();
    const selectedTab = tabs[block - 1];
    if (!selectedTab) throw new ApiError(422, "course_block_unavailable", "The requested course block does not exist for this term.");
    const creditsEarned = parseDecimal($("font[color='red']").eq(2).text().trim());
    const clickData = $(selectedTab).attr("onclick")?.match(/'([^']*)'/g)?.map((item) => item.slice(1, -1)) ?? [];
    if (clickData.length < 2) throw new ApiError(422, "course_block_unavailable", "Course block metadata is incomplete.");
    const head: Record<string, string> = {};
    $("input[type='hidden']").each((_, element) => { const name = $(element).attr("name"); if (name) head[name] = $(element).attr("value") ?? ""; });
    const display = (await this.request("xsxk/zzxkyzb_cxZzxkYzbDisplay.html?gnmkdm=N253512", { method: "POST", form: { xkkz_id: clickData[1], xszxzt: 1, kspage: 0 } })).text;
    const displayDoc = load(display);
    displayDoc("input[type='hidden']").each((_, element) => { const name = displayDoc(element).attr("name"); if (name) head[name] = displayDoc(element).attr("value") ?? ""; });
    const wireBlock = { bklx_id: head.bklx_id,
       xqh_id: head.xqh_id,
       zyfx_id: head.zyfx_id,
       njdm_id: head.njdm_id,
       bh_id: head.bh_id,
       xbm: head.xbm,
       xslbdm: head.xslbdm,
       ccdm: head.ccdm,
       xsbj: head.xsbj,
       xkxnm: query.academicYear,
       xkxqm: academicTermCode(query.term),
       kklxdm: clickData[0],
       kkbk: head.kkbk,
       rwlx: head.rwlx,
       kspage: 1,
       jspage: 10 };
    const courseResult = asRecord(await this.postJson("xsxk/zzxkyzb_cxZzxkYzbPartDisplay.html?gnmkdm=N253512", wireBlock));
    const rawCourses = asList(courseResult.tmpList);
    if (rawCourses.length === 0) return { block, creditsEarned, count: 0, courses: [] };
    const classResult = asList(await this.postJson("xsxk/zzxkyzb_cxJxbWithKchZzxkYzb.html?gnmkdm=N253512", { bklx_id: head.bklx_id,
       xkxnm: query.academicYear,
       xkxqm: academicTermCode(query.term),
       xkkz_id: clickData[1],
       xqh_id: head.xqh_id,
       zyfx_id: head.zyfx_id,
       njdm_id: head.njdm_id,
       bh_id: head.bh_id,
       xbm: head.xbm,
       xslbdm: head.xslbdm,
       ccdm: head.ccdm,
       xsbj: head.xsbj,
       kklxdm: clickData[0],
       kch_id: rawCourses[0]!.kch_id,
       kkbk: head.kkbk,
       rwlx: head.rwlx,
       zyh_id: head.zyh_id }));
    return { block, creditsEarned, count: rawCourses.length, courses: rawCourses.map((item, index) => {
      const classInfo = asRecord(classResult[index]); const teacherParts = String(item.jsxx ?? "").match(/(.*?\d+)\/(.*?)\//);
      return { courseId: item.kch_id ?? null,
         classId: item.jxb_id ?? classInfo.jxb_id ?? null,
         executionId: item.do_jxb_id ?? classInfo.do_jxb_id ?? null,
         title: item.kcmc ?? null,
         teacherId: teacherParts?.[1] ?? null,
         teacher: teacherParts?.[2] ?? null,
         credits: parseDecimal(item.xf),
         blockCode: clickData[0],
         capacity: Number(classInfo.jxbrl ?? 0),
         enrollmentCount: Number(classInfo.yxzrs ?? 0),
         location: this.getPlace(classInfo.jxdd),
         meetingTime: this.getCourseTime(classInfo.sksj) };
    }) };
  }

  async enroll(course: { studentId: string; courseId: string; executionId: string; blockCode: string; academicYear: number; term: number }): Promise<unknown> {
    return this.postJson("xsxk/zzxkyzb_xkBcZyZzxkYzb.html?gnmkdm=N253512", { jxb_ids: course.executionId,
       kch_id: course.courseId,
       qz: 0,
       xkxnm: course.academicYear,
       xkxqm: academicTermCode(course.term),
       njdm_id: course.studentId.slice(0,
       2),
       zyh_id: course.studentId.slice(2,
       6),
       kklxdm: course.blockCode });
  }

  async withdraw(course: { courseId: string; executionId: string; academicYear: number; term: number }): Promise<{ status: string | null }> {
    const response = await this.request("xsxk/zzxkyzb_tuikBcZzxkYzb.html?gnmkdm=N253512", { method: "POST",
       form: { jxb_ids: course.executionId, kch_id: course.courseId, xkxnm: course.academicYear, xkxqm: academicTermCode(course.term) } });
    return { status: response.text.match(/\d+/)?.[0] ?? null };
  }

  async getGpa(): Promise<number | null> {
    const html = (await this.request("xsxy/xsxyqk_cxXsxyqkIndex.html?gnmkdm=N105515&layout=default")).text;
    const $ = load(html); const text = $("font[size='2px']").map((_, element) => $(element).text()).get()[2];
    const result = Number.parseFloat(text ?? ""); return Number.isFinite(result) ? result : null;
  }

  private getPlace(value: unknown): string | null { return textValue(value)?.split("<br/>")[0] ?? null; }
  private getCourseTime(value: unknown): string | null { return textValue(value)?.split("<br/>").join("、") ?? null; }
}
