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
    for (const t of authTabs) t.classList.toggle("active", t === tab);
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
