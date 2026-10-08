const sessionId = new URLSearchParams(window.location.search).get("session");
const form = document.querySelector("#checkin-form");
const message = document.querySelector("#checkin-message");
const submitButton = form.querySelector("button");

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function showMessage(text, kind = "") {
  message.textContent = text;
  message.className = `checkin-message ${kind}`;
}

if (!sessionId) {
  form.hidden = true;
  showMessage("This QR code is missing its attendance session.", "error");
} else {
  api(`/api/checkin/${encodeURIComponent(sessionId)}`)
    .then((session) => {
      const date = new Date(`${session.date}T00:00:00`).toLocaleDateString();
      document.querySelector("#checkin-subtitle").textContent = `${session.title} · ${date}`;
    })
    .catch((error) => {
      form.hidden = true;
      showMessage(error.message, "error");
    });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!sessionId) return;
  submitButton.disabled = true;
  submitButton.textContent = "Recording attendance…";
  showMessage();
  try {
    const result = await api(`/api/checkin/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      body: JSON.stringify({ misNumber: new FormData(form).get("misNumber") }),
    });
    form.hidden = true;
    document.querySelector("#checkin-title").textContent = "Attendance recorded";
    showMessage(`Thank you, ${result.name}. You have been marked present.`, "success");
  } catch (error) {
    submitButton.disabled = false;
    submitButton.textContent = "Confirm my attendance";
    showMessage(error.message, "error");
  }
});
