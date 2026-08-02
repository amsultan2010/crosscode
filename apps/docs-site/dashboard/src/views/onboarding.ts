type Step = { title: string; body: string };

const STEPS: Step[] = [
  {
    title: "Welcome to Crosscode",
    body: "Your account and workspace are set up. This dashboard is a read-only window into your workspace -- live presence, tasks, claims, proposals, and validation status. Accepting or rejecting a proposal still happens through your terminal or coding agent, never from a browser."
  },
  {
    title: "What you're looking at",
    body: "Stat cards up top summarize live presence, recent operations (settled edits), validation pass rate, and your plan's seat usage. Below that, panels break out tasks, claims, handoffs, intents, and a full edit history. Everything updates live over a WebSocket connection while this page is open."
  }
];

export function renderOnboarding(container: HTMLElement, onDone: () => void): void {
  let index = 0;
  let installPrompt: string | undefined;

  render();

  function render(): void {
    const step = STEPS[index];
    const isInstallStep = index === STEPS.length;
    const total = STEPS.length + 1;

    container.innerHTML = `
      <div class="onboarding-shell">
        <div class="onboarding-progress">
          ${Array.from({ length: total }, (_, i) => `<span class="${i <= index ? "done" : ""}"></span>`).join("")}
        </div>
        <div class="onboarding-step">
          ${isInstallStep ? renderInstallStep() : `<h1>${escapeHtml(step!.title)}</h1><p>${escapeHtml(step!.body)}</p>`}
        </div>
        <div class="onboarding-actions">
          <button type="button" class="skip" id="onboarding-skip">Skip</button>
          <button type="button" class="next" id="onboarding-next">${isInstallStep ? "Go to dashboard" : "Continue"}</button>
        </div>
      </div>
    `;

    container.querySelector<HTMLButtonElement>("#onboarding-skip")!.addEventListener("click", onDone);
    container.querySelector<HTMLButtonElement>("#onboarding-next")!.addEventListener("click", () => {
      if (isInstallStep) {
        onDone();
        return;
      }
      index += 1;
      render();
    });

    if (isInstallStep) {
      const copyBtn = container.querySelector<HTMLButtonElement>("#onboarding-copy");
      copyBtn?.addEventListener("click", () => {
        if (!installPrompt) return;
        void navigator.clipboard.writeText(installPrompt).then(() => {
          copyBtn.textContent = "Copied";
          setTimeout(() => { copyBtn.textContent = "Copy prompt"; }, 1500);
        });
      });
      if (!installPrompt) {
        void fetch("/docs/install-prompt.md")
          .then((response) => (response.ok ? response.text() : Promise.reject(new Error("not found"))))
          .then((text) => {
            // The doc wraps the actual copy-pasteable prompt in a 4-backtick fence
            // (```` ```text ... ``` ````, 4 backticks since the prompt itself contains
            // 3-backtick fenced blocks) surrounded by explanatory prose -- extract just
            // the fenced content, matching what the landing page's copy button sends.
            const match = text.match(/````text\n([\s\S]*?)\n````/);
            installPrompt = (match ? match[1] : text)!.trimEnd();
            const pre = container.querySelector<HTMLPreElement>("#onboarding-install-text");
            if (pre) pre.textContent = installPrompt;
          })
          .catch(() => {
            const pre = container.querySelector<HTMLPreElement>("#onboarding-install-text");
            if (pre) pre.textContent = "Couldn't load the install prompt -- see the Docs page instead.";
          });
      }
    }
  }

  function renderInstallStep(): string {
    return `
      <h1>Set up an MCP-capable agent</h1>
      <p>If you haven't already, paste this into Claude Code, Codex CLI, OpenCode, Cursor, or any other MCP-capable agent to wire up Crosscode for a project.</p>
      <div class="onboarding-install">
        <button type="button" id="onboarding-copy">Copy prompt</button>
        <pre id="onboarding-install-text">Loading…</pre>
      </div>
    `;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
