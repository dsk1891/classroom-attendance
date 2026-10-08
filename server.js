const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID, randomBytes, timingSafeEqual } = require("node:crypto");
const QRCode = require("qrcode");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = process.env.ATTENDANCE_DATA_FILE || path.join(DATA_DIR, "attendance.json");
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_URL = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).origin : null;
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || randomBytes(18).toString("base64url");
const MAX_BODY_BYTES = 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDatabase() {
  if (!fs.existsSync(DATA_FILE)) return { students: [], sessions: [] };
  const database = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!Array.isArray(database.students) || !Array.isArray(database.sessions)) {
    throw new Error(`Invalid attendance data in ${DATA_FILE}`);
  }
  const migrateStudent = (student) => ({
    ...student,
    misNumber: student.misNumber ?? student.studentId ?? "",
    departmentName: student.departmentName ?? student.className ?? "",
  });
  database.students = database.students.map(migrateStudent);
  database.sessions = database.sessions.map((session) => ({
    ...session,
    roster: Array.isArray(session.roster) ? session.roster.map(migrateStudent) : database.students.map(migrateStudent),
    attendance: session.attendance || {},
  }));
  return database;
}

let database = loadDatabase();

function cloneDatabase() {
  return JSON.parse(JSON.stringify(database));
}

function saveDatabase(nextDatabase) {
  const temporaryFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(nextDatabase, null, 2), "utf8");
  fs.renameSync(temporaryFile, DATA_FILE);
  database = nextDatabase;
}

function json(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function isPublicCheckin(request, pathname) {
  return /^\/api\/checkin\/[^/]+$/.test(pathname)
    && (request.method === "GET" || request.method === "POST");
}

function hasTeacherAccess(request) {
  const supplied = request.headers["x-teacher-password"];
  if (typeof supplied !== "string") return false;
  const expectedBuffer = Buffer.from(TEACHER_PASSWORD);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Request body must be a JSON object.");
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function getLanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "localhost";
}

function appUrl() {
  return PUBLIC_URL || `http://${getLanAddress()}:${PORT}`;
}

function getSession(id) {
  return database.sessions.find((session) => session.id === id);
}

function activeSession() {
  return database.sessions.find((session) => session.status === "active");
}

function csvCell(value) {
  const text = String(value ?? "");
  const safeText = /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

function sendCsv(response, session) {
  const rows = [
    ["Session", "MIS Number", "Student Name", "Department Name", "Status", "Marked At"],
    ...session.roster.map((student) => {
      const record = session.attendance[student.id];
      return [
        session.title,
        student.misNumber,
        student.name,
        student.departmentName,
        record ? "Present" : "Absent",
        record?.scannedAt || "",
      ];
    }),
  ];
  const content = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  response.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="attendance-${session.date}.csv"`,
    "Content-Length": Buffer.byteLength(content),
  });
  response.end(content);
}

function validateStudents(students, existingStudents) {
  if (!Array.isArray(students) || students.length === 0) {
    return { error: "Choose a CSV file containing at least one student." };
  }
  if (students.length > 2000) return { error: "Import is limited to 2,000 students at a time." };
  const knownMisNumbers = new Set(existingStudents.map((student) => student.misNumber.toLowerCase()));
  const errors = [];
  const validated = students.map((row, index) => {
    const source = row && typeof row === "object" && !Array.isArray(row) ? row : {};
    const student = {
      name: typeof source.name === "string" ? source.name.trim() : "",
      misNumber: typeof source.misNumber === "string" ? source.misNumber.trim() : "",
      departmentName: typeof source.departmentName === "string" ? source.departmentName.trim() : "",
    };
    const rowErrors = [];
    if (!student.name || !student.misNumber || !student.departmentName) {
      rowErrors.push("Student name, MIS number, and department name are required.");
    } else if (knownMisNumbers.has(student.misNumber.toLowerCase())) {
      rowErrors.push(`MIS number "${student.misNumber}" is already in use.`);
    }
    if (student.name.length > 80 || student.misNumber.length > 32 || student.departmentName.length > 50) {
      rowErrors.push("A field exceeds its maximum length.");
    }
    if (rowErrors.length) {
      errors.push({ row: index + 2, messages: rowErrors });
      return null;
    }
    knownMisNumbers.add(student.misNumber.toLowerCase());
    return { id: randomUUID(), ...student };
  });
  if (errors.length) return { error: "No students were imported. Fix the listed rows and try again.", rows: errors };
  return { students: validated };
}

async function handleApi(request, response, url) {
  const { pathname } = url;
  if (!isPublicCheckin(request, pathname) && !hasTeacherAccess(request)) {
    json(response, 401, { error: "Teacher password required." });
    return;
  }
  if (request.method === "GET" && pathname === "/api/state") {
    json(response, 200, {
      students: database.students,
      sessions: [...database.sessions].reverse(),
      localUrl: appUrl(),
    });
    return;
  }

  if (request.method === "POST" && (pathname === "/api/students" || pathname === "/api/students/import")) {
    if (activeSession()) {
      json(response, 409, { error: "End the active attendance session before changing the roster." });
      return;
    }
    const body = await readJson(request);
    const rows = pathname === "/api/students" ? [body] : body.students;
    const result = validateStudents(rows, database.students);
    if (result.error) {
      json(response, 400, result);
      return;
    }
    if (pathname === "/api/students") {
      const nextDatabase = cloneDatabase();
      nextDatabase.students.push(result.students[0]);
      saveDatabase(nextDatabase);
      json(response, 201, { student: result.students[0] });
      return;
    }
    const nextDatabase = cloneDatabase();
    nextDatabase.students.push(...result.students);
    saveDatabase(nextDatabase);
    json(response, 201, { imported: result.students.length });
    return;
  }

  const deleteMatch = pathname.match(/^\/api\/students\/([^/]+)$/);
  if (request.method === "DELETE" && deleteMatch) {
    if (activeSession()) {
      json(response, 409, { error: "End the active attendance session before changing the roster." });
      return;
    }
    const studentId = decodeURIComponent(deleteMatch[1]);
    const index = database.students.findIndex((student) => student.id === studentId);
    if (index < 0) {
      json(response, 404, { error: "Student not found." });
      return;
    }
    const nextDatabase = cloneDatabase();
    nextDatabase.students.splice(index, 1);
    saveDatabase(nextDatabase);
    json(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && pathname === "/api/sessions") {
    const body = await readJson(request);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 80) {
      json(response, 400, { error: "Enter a class or session name up to 80 characters." });
      return;
    }
    if (database.students.length === 0) {
      json(response, 400, { error: "Add at least one student before starting attendance." });
      return;
    }
    if (activeSession()) {
      json(response, 409, { error: "End the active session before starting another." });
      return;
    }
    const now = new Date();
    const session = {
      id: randomUUID(),
      title,
      date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
      startedAt: now.toISOString(),
      status: "active",
      roster: database.students.map((student) => ({ ...student })),
      attendance: {},
    };
    const nextDatabase = cloneDatabase();
    nextDatabase.sessions.push(session);
    saveDatabase(nextDatabase);
    json(response, 201, { session });
    return;
  }

  const qrMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/qr$/);
  if (request.method === "GET" && qrMatch) {
    const session = getSession(decodeURIComponent(qrMatch[1]));
    if (!session || session.status !== "active") {
      json(response, 404, { error: "Active session not found." });
      return;
    }
    const checkinUrl = `${appUrl()}/checkin?session=${encodeURIComponent(session.id)}`;
    const dataUrl = await QRCode.toDataURL(checkinUrl, { errorCorrectionLevel: "M", margin: 2, width: 300 });
    json(response, 200, { dataUrl, checkinUrl });
    return;
  }

  const checkinMatch = pathname.match(/^\/api\/checkin\/([^/]+)$/);
  if (checkinMatch) {
    const session = getSession(decodeURIComponent(checkinMatch[1]));
    if (!session || session.status !== "active") {
      json(response, 404, { error: "This attendance session is no longer active." });
      return;
    }
    if (request.method === "GET") {
      json(response, 200, { title: session.title, date: session.date });
      return;
    }
    if (request.method === "POST") {
      const body = await readJson(request);
      const misNumber = typeof body.misNumber === "string" ? body.misNumber.trim() : "";
      const student = database.students.find((item) => item.misNumber.toLowerCase() === misNumber.toLowerCase());
      if (!student || !session.roster.some((item) => item.id === student.id)) {
        json(response, 404, { error: "MIS number not found in this class roster. Check it and try again." });
        return;
      }
      if (session.attendance[student.id]) {
        json(response, 409, { error: "Your attendance has already been recorded." });
        return;
      }
      const nextDatabase = cloneDatabase();
      const nextSession = nextDatabase.sessions.find((item) => item.id === session.id);
      nextSession.attendance[student.id] = { scannedAt: new Date().toISOString() };
      saveDatabase(nextDatabase);
      json(response, 201, { name: student.name });
      return;
    }
  }

  const attendanceMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/attendance$/);
  if (request.method === "POST" && attendanceMatch) {
    const session = getSession(decodeURIComponent(attendanceMatch[1]));
    if (!session || session.status !== "active") {
      json(response, 404, { error: "No active attendance session was found." });
      return;
    }
    const body = await readJson(request);
    const studentId = typeof body.studentId === "string" ? body.studentId : "";
    if (!session.roster.some((student) => student.id === studentId)) {
      json(response, 404, { error: "Student not found in this session roster." });
      return;
    }
    const nextDatabase = cloneDatabase();
    const nextSession = nextDatabase.sessions.find((item) => item.id === session.id);
    if (nextSession.attendance[studentId]) delete nextSession.attendance[studentId];
    else nextSession.attendance[studentId] = { scannedAt: new Date().toISOString() };
    saveDatabase(nextDatabase);
    json(response, 200, { ok: true });
    return;
  }

  const endMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/end$/);
  if (request.method === "POST" && endMatch) {
    const session = getSession(decodeURIComponent(endMatch[1]));
    if (!session || session.status !== "active") {
      json(response, 409, { error: "This session is not active." });
      return;
    }
    const nextDatabase = cloneDatabase();
    const nextSession = nextDatabase.sessions.find((item) => item.id === session.id);
    nextSession.status = "ended";
    nextSession.endedAt = new Date().toISOString();
    saveDatabase(nextDatabase);
    json(response, 200, { ok: true });
    return;
  }

  const reportMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/report\.csv$/);
  if (request.method === "GET" && reportMatch) {
    const session = getSession(decodeURIComponent(reportMatch[1]));
    if (!session) {
      json(response, 404, { error: "Attendance session not found." });
      return;
    }
    sendCsv(response, session);
    return;
  }

  json(response, 404, { error: "API endpoint not found." });
}

function serveStatic(response, url) {
  let requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  if (requestedPath === "/checkin") requestedPath = "/checkin.html";
  const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
  const relativePath = path.relative(PUBLIC_DIR, filePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Page not found.");
      return;
    }
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".csv": "text/csv; charset=utf-8",
    };
    response.writeHead(200, { "Content-Type": types[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-cache" });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Method not allowed.");
      return;
    }
    serveStatic(response, url);
  } catch (error) {
    if (!response.headersSent) {
      json(response, error.statusCode || 500, {
        error: error.statusCode ? error.message : "The server could not complete the request.",
      });
    }
    if (!error.statusCode) console.error(error);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Attendance dashboard: http://localhost:${PORT}`);
  console.log(`Student phone URL: ${appUrl()}`);
  if (!process.env.TEACHER_PASSWORD) console.log(`Teacher password for this run: ${TEACHER_PASSWORD}`);
});
