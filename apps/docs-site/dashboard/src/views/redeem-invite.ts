import { redeemInvite, ApiError, type SessionContext } from "../lib/api.js";
import { setStoredWorkspaceId } from "../lib/workspace.js";

export function renderRedeemInvite(container: HTMLElement, session: SessionContext, onJoined: (workspaceId: string) => void): void {
  container.innerHTML = `
    <div class="auth-card">
      <h1>Redeem an invite</h1>
      <p class="muted">Paste the invite code a workspace owner shared with you.</p>
      <form id="invite-form" class="stack">
        <label>
          Invite code
          <input type="text" name="code" required autocomplete="off" spellcheck="false" />
        </label>
        <button type="submit">Join workspace</button>
        <p id="invite-status" class="muted" hidden></p>
        <p id="invite-error" class="error" hidden></p>
      </form>
    </div>
  `;

  const form = container.querySelector<HTMLFormElement>("#invite-form")!;
  const statusEl = container.querySelector<HTMLParagraphElement>("#invite-status")!;
  const errorEl = container.querySelector<HTMLParagraphElement>("#invite-error")!;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void handleSubmit();
  });

  async function handleSubmit(): Promise<void> {
    errorEl.hidden = true;
    statusEl.hidden = true;
    const code = String(new FormData(form).get("code") ?? "").trim();
    if (!code) return;
    const submitButton = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    submitButton.disabled = true;
    try {
      const result = await redeemInvite(session, code);
      setStoredWorkspaceId(result.workspaceId);
      onJoined(result.workspaceId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        errorEl.textContent = "That invite code wasn't found. Double check it with your workspace owner.";
      } else {
        errorEl.textContent = error instanceof Error ? error.message : "Could not redeem invite";
      }
      errorEl.hidden = false;
    } finally {
      submitButton.disabled = false;
    }
  }
}
