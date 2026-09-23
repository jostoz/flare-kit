// Client-side entry. Intentionally minimal: the SSR HTML from src/app/render.tsx
// is already fully rendered and interactive-free by default (TRD §3.1). Add
// hydration/interactivity here only for components that genuinely need it —
// most of the kit's pages should stay static SSR to keep CPU cost near zero.

// Landing page auth form (src/app/components/Landing.tsx): a no-op on any
// page without these elements, so this costs nothing on /dashboard or any
// future page that doesn't render the form.
const authTabs = document.querySelectorAll("[data-auth-tab]");
const authForms = document.querySelectorAll("[data-auth-form]");

for (const tab of authTabs) {
  tab.addEventListener("click", () => {
    const target = tab.getAttribute("data-auth-tab");
    for (const t of authTabs) {
      const isActive = t === tab;
      t.classList.toggle("active", isActive);
      t.setAttribute("aria-selected", String(isActive));
    }
    for (const form of authForms) form.hidden = form.getAttribute("data-auth-form") !== target;
  });
}

for (const form of authForms) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = form.querySelector("[data-auth-error]");
    errorEl.hidden = true;

    const kind = form.getAttribute("data-auth-form"); // "sign-up" | "sign-in"
    const data = Object.fromEntries(new FormData(form).entries());
    const endpoint = kind === "sign-up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email";

    const submitButton = form.querySelector("button[type=submit]");
    submitButton.disabled = true;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        errorEl.textContent = body.message || "Something went wrong. Please try again.";
        errorEl.hidden = false;
        return;
      }
      window.location.href = "/dashboard";
    } catch {
      errorEl.textContent = "Network error. Please try again.";
      errorEl.hidden = false;
    } finally {
      submitButton.disabled = false;
    }
  });
}

// Dashboard chat panel (src/app/components/UserDashboard.tsx): a no-op on
// any page without these elements (e.g. the landing page). Patterns below
// (optimistic append, a pending indicator instead of real streaming since
// /api/ai/chat returns one JSON response not an SSE stream, Enter-to-send,
// auto-scroll, an ARIA live region) are the same ones a framework chat
// library (Vercel AI SDK's useChat, assistant-ui) would give for free —
// reimplemented here in plain JS to keep this repo's zero-client-bundler,
// zero-framework-on-the-client architecture (see AGENTS.md / README
// "Deviation from the original plan").
const chatForm = document.getElementById("chat-form");
if (chatForm) {
  const chatLog = document.getElementById("chat-log");
  chatLog.setAttribute("aria-live", "polite");
  chatLog.setAttribute("role", "log");

  const promptField = chatForm.querySelector("textarea[name=prompt]");
  const fileInput = chatForm.querySelector("input[name=image]");
  const attachLabel = chatForm.querySelector(".chat-attach");
  const filenameEl = chatForm.querySelector("[data-chat-filename]");
  const errorEl = chatForm.querySelector("[data-chat-error]");
  const submitButton = chatForm.querySelector("button[type=submit]");
  const emptyState = chatLog.querySelector("[data-chat-empty]");

  function appendMessage(role, text, opts = {}) {
    if (emptyState) emptyState.remove();
    const el = document.createElement("div");
    el.className = `chat-msg chat-msg-${role}${opts.pending ? " is-pending" : ""}`;
    const roleEl = document.createElement("span");
    roleEl.className = "mono chat-role";
    roleEl.textContent = role;
    const bodyEl = document.createElement("p");
    bodyEl.textContent = text;
    el.append(roleEl, bodyEl);
    chatLog.appendChild(el);
    chatLog.scrollTop = chatLog.scrollHeight;
    return el;
  }

  // Enter sends; Shift+Enter inserts a newline — the standard chat-input convention.
  promptField.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      chatForm.requestSubmit();
    }
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    filenameEl.textContent = file ? file.name : "";
    attachLabel.classList.toggle("has-file", Boolean(file));
  });

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.hidden = true;

    const prompt = promptField.value.trim();
    const file = fileInput.files[0];
    if (!prompt) return;

    let image;
    if (file) {
      image = { mimeType: file.type, data: await readFileAsBase64(file) };
    }

    appendMessage("user", prompt);
    const pendingEl = appendMessage("assistant", "Thinking", { pending: true });
    promptField.value = "";
    fileInput.value = "";
    filenameEl.textContent = "";
    attachLabel.classList.remove("has-file");
    submitButton.disabled = true;

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, ...(image ? { image } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        pendingEl.remove();
        errorEl.textContent = body.message || "The assistant couldn't respond. Please try again.";
        errorEl.hidden = false;
        return;
      }
      pendingEl.remove();
      appendMessage("assistant", body.result ?? "");
    } catch {
      pendingEl.remove();
      errorEl.textContent = "Network error. Please try again.";
      errorEl.hidden = false;
    } finally {
      submitButton.disabled = false;
    }
  });
}
