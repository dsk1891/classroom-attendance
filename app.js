const studentList = document.querySelector("#student-list");
const reportList = document.querySelector("#report-list");
const toast = document.querySelector("#toast");
let state = { students: [], sessions: [], localUrl: window.location.origin };
let toastTimer;
let activeSessionId = null;
let refreshing = false;
let teacherPassword = sessionStorage.getItem("attendance-teacher-password") || "";
let passwordPrompt;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 4200);
}

async function authorizedFetch(path, options = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
        ...(teacherPassword ? { "X-Teacher-Password": teacherPassword } : {}),
      },
    });
    if (response.status === 401 && attempt === 0) {
      teacherPassword = await requestTeacherPassword();
      sessionStorage.setItem("attendance-teacher-password", teacherPassword);
      continue;
    }
    if (response.status === 401) {
      teacherPassword = "";
      sessionStorage.removeItem("attendance-teacher-password");
    }
    return response;
  }
  throw new Error("Teacher authentication failed.");
}

async function api(path, options = {}) {
  const response = await authorizedFetch(path, options);
  const type = response.headers.get("content-type") || "";
  const result = type.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(result?.error || `Request failed (${response.status}).`);
    error.rows = result?.rows;
    throw error;
  }
  return result;
}

async function downloadReport(sessionId) {
  const response = await authorizedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/report.csv`);
  if (!response.ok) {
    const result = await response.json();
    throw new Error(result.error || `Request failed (${response.status}).`);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  const session = state.sessions.find((item) => item.id === sessionId);
  link.download = `attendance-${session?.date || "report"}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function requestTeacherPassword() {
  if (passwordPrompt) return passwordPrompt;
  const dialog = document.querySelector("#teacher-login");
  const form = document.querySelector("#teacher-login-form");
  const input = form.elements.password;
  passwordPrompt = new Promise((resolve, reject) => {
    const cleanup = () => {
      form.removeEventListener("submit", onSubmit);
      dialog.removeEventListener("cancel", onCancel);
      passwordPrompt = null;
    };
    const onSubmit = (event) => {
      event.preventDefault();
      const value = input.value;
      input.value = "";
      cleanup();
      dialog.close();
      resolve(value);
    };
    const onCancel = (event) => {
      event.preventDefault();
      cleanup();
      reject(new Error("Teacher sign-in was cancelled."));
    };
    form.addEventListener("submit", onSubmit);
    dialog.addEventListener("cancel", onCancel);
    dialog.showModal();
    input.focus();
  });
  return passwordPrompt;
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function getActiveSession() {
  return state.sessions.find((session) => session.status === "active") || null;
}

function getTodaySession() {
  const today = new Date();
  const localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return state.sessions.find((session) => session.date === localDate) || null;
}

function renderStudents(active, displaySession) {
  const locked = Boolean(active);
  studentList.innerHTML = state.students.map((student) => {
    const present = Boolean(displaySession?.attendance?.[student.id]);
    const badge = displaySession ? (present ? "badge-present" : "badge-absent") : "badge-neutral";
    const status = displaySession ? (present ? "Present" : "Absent") : "—";
    const action = active
      ? `<button class="attendance-button ${present ? "is-present" : ""}" type="button" data-attendance="${escapeHtml(student.id)}">${present ? "Undo" : "Mark present"}</button>`
      : `<button class="delete-button" type="button" data-delete="${escapeHtml(student.id)}" aria-label="Remove ${escapeHtml(student.name)}">×</button>`;
    return `<tr>
      <td><span class="student-name"><span class="student-avatar">${escapeHtml(student.name.trim().charAt(0).toUpperCase())}</span>${escapeHtml(student.name)}</span></td>
      <td class="id-cell">${escapeHtml(student.misNumber)}</td>
      <td>${escapeHtml(student.departmentName)}</td>
      <td><span class="badge ${badge}">${status}</span></td>
      <td>${action}</td>
    </tr>`;
  }).join("");
  document.querySelector("#empty-roster").hidden = state.students.length > 0;
  document.querySelector("#roster-count").textContent = `${state.students.length} ${state.students.length === 1 ? "student" : "students"}`;
  document.querySelector("#total-students").textContent = state.students.length;
  document.querySelectorAll("#student-form input, #student-form button, #student-import").forEach((control) => {
    control.disabled = locked;
  });
  document.querySelector("#roster-lock-hint").hidden = !locked;
  document.querySelector("#import-help").textContent = locked
    ? "End the active attendance session before changing the roster."
    : "CSV columns: name, misNumber, departmentName. Save Excel sheets as CSV UTF-8.";
}

function renderActivity(session) {
  const activity = document.querySelector("#activity-list");
  const empty = document.querySelector("#empty-activity");
  if (!session) {
    activity.replaceChildren();
    empty.hidden = false;
    return;
  }
  const entries = Object.entries(session.attendance || {})
    .map(([studentId, record]) => ({
      student: session.roster.find((item) => item.id === studentId),
      scannedAt: record.scannedAt,
    }))
    .filter((entry) => entry.student)
    .sort((left, right) => right.scannedAt.localeCompare(left.scannedAt));
  empty.hidden = entries.length > 0;
  activity.innerHTML = entries.slice(0, 6).map(({ student, scannedAt }) => `
    <div class="activity-item">
      <span class="activity-avatar">${escapeHtml(student.name.trim().charAt(0).toUpperCase())}</span>
      <span class="activity-name"><strong>${escapeHtml(student.name)}</strong><small>${escapeHtml(student.misNumber)}</small></span>
      <span class="activity-time">${escapeHtml(formatTime(scannedAt))}</span>
    </div>`).join("");
}

function renderReports() {
  const completed = state.sessions.filter((session) => session.status === "ended");
  reportList.innerHTML = completed.map((session) => {
    const present = Object.keys(session.attendance).length;
    const absent = Math.max(0, session.roster.length - present);
    return `<tr>
      <td><strong>${escapeHtml(session.title)}</strong></td>
      <td>${escapeHtml(session.date)}</td>
      <td><span class="badge badge-neutral">Completed</span></td>
      <td>${present} present <span class="report-absent">· ${absent} absent</span></td>
      <td><button class="text-link report-download" type="button" data-report="${escapeHtml(session.id)}">↓ CSV report</button></td>
    </tr>`;
  }).join("");
  document.querySelector("#empty-reports").hidden = completed.length > 0;
}

function render() {
  const active = getActiveSession();
  const displaySession = active || getTodaySession();
  const presentCount = displaySession ? Object.keys(displaySession.attendance).length : 0;
  const rosterSize = displaySession ? displaySession.roster.length : 0;

  renderStudents(active, displaySession);
  renderActivity(displaySession);
  renderReports();
  document.querySelector("#present-count").textContent = presentCount;
  document.querySelector("#absent-count").textContent = Math.max(0, rosterSize - presentCount);
  document.querySelector("#present-caption").textContent = displaySession
    ? (active ? "Checked in so far" : "Session completed")
    : "No active session";
  document.querySelector("#absent-caption").textContent = displaySession
    ? (active ? "Not checked in yet" : "Session completed")
    : "Start a session to track";
  document.querySelector("#session-form").hidden = Boolean(active);
  document.querySelector("#active-session").hidden = !active;
  document.querySelector("#network-hint").hidden = !active;
  if (active) {
    document.querySelector("#session-title").textContent = active.title;
    document.querySelector("#network-hint").textContent =
      `Phone check-in link: ${state.localUrl}/checkin. Keep this app running and have students connect to the same Wi-Fi.`;
  }
}

async function refresh(showErrors = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const nextState = await api("/api/state");
    state = nextState;
    render();
    const active = getActiveSession();
    if (active && active.id !== activeSessionId) {
      const qr = await api(`/api/sessions/${encodeURIComponent(active.id)}/qr`);
      if (getActiveSession()?.id === active.id) {
        document.querySelector("#session-qr").src = qr.dataUrl;
        const link = document.querySelector("#phone-link");
        link.href = qr.checkinUrl;
        link.textContent = qr.checkinUrl.replace(/^https?:\/\//, "");
        activeSessionId = active.id;
      }
    } else if (!active) {
      activeSessionId = null;
    }
  } catch (error) {
    if (showErrors) showToast(error.message);
  } finally {
    refreshing = false;
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("The CSV contains a cell with an unclosed quotation mark.");
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

document.querySelector("#today-date").textContent = new Date().toLocaleDateString([], {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

document.querySelector("#student-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const student = Object.fromEntries(new FormData(form));
  try {
    await api("/api/students", { method: "POST", body: JSON.stringify(student) });
    form.reset();
    showToast("Student added to the class roster.");
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
});

studentList.addEventListener("click", async (event) => {
  const attendanceButton = event.target.closest("[data-attendance]");
  const deleteButton = event.target.closest("[data-delete]");
  try {
    if (attendanceButton) {
      const active = getActiveSession();
      if (!active) return;
      await api(`/api/sessions/${encodeURIComponent(active.id)}/attendance`, {
        method: "POST",
        body: JSON.stringify({ studentId: attendanceButton.dataset.attendance }),
      });
      await refresh();
    } else if (deleteButton) {
      if (!window.confirm("Remove this student from the current roster? Past reports keep their original records.")) return;
      await api(`/api/students/${encodeURIComponent(deleteButton.dataset.delete)}`, { method: "DELETE" });
      showToast("Student removed.");
      await refresh();
    }
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#student-import").addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  input.disabled = true;
  try {
    const rows = parseCsv((await file.text()).replace(/^\uFEFF/, ""));
    if (rows.length < 2) throw new Error("The CSV needs a header row and at least one student.");
    const headers = rows[0].map((header) => header.trim().toLowerCase());
    const nameColumn = headers.indexOf("name");
    const misColumn = headers.indexOf("misnumber") >= 0 ? headers.indexOf("misnumber") : headers.indexOf("studentid");
    const departmentColumn = headers.indexOf("departmentname") >= 0 ? headers.indexOf("departmentname") : headers.indexOf("classname");
    if ([nameColumn, misColumn, departmentColumn].some((column) => column < 0)) {
      throw new Error("CSV headers must be name, misNumber, and departmentName. The older studentId/className headers are also accepted.");
    }
    const students = rows.slice(1).map((row) => ({
      name: row[nameColumn]?.trim() || "",
      misNumber: row[misColumn]?.trim() || "",
      departmentName: row[departmentColumn]?.trim() || "",
    }));
    const result = await api("/api/students/import", { method: "POST", body: JSON.stringify({ students }) });
    showToast(`${result.imported} ${result.imported === 1 ? "student" : "students"} imported.`);
    await refresh();
  } catch (error) {
    let detail = "";
    if (error.rows) {
      detail = ` ${error.rows.slice(0, 4).map((row) => `Row ${row.row}: ${row.messages.join(" ")}`).join(" ")}`;
    }
    showToast(`${error.message}${detail}`);
  } finally {
    input.value = "";
    input.disabled = Boolean(getActiveSession());
  }
});

document.querySelector("#session-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: new FormData(form).get("title") }),
    });
    form.reset();
    await refresh(true);
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#end-session").addEventListener("click", async () => {
  const active = getActiveSession();
  if (!active || !window.confirm("End this attendance session? Students will no longer be able to check in.")) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(active.id)}/end`, { method: "POST" });
    showToast("Session ended. The attendance CSV report is ready.");
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
});

reportList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-report]");
  if (!button) return;
  try {
    await downloadReport(button.dataset.report);
  } catch (error) {
    showToast(error.message);
  }
});

refresh(true);
setInterval(() => refresh(), 2500);
