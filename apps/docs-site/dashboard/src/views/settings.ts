import type { Session } from "@supabase/supabase-js";
import { getSupabaseClient } from "../lib/supabase.js";
import { getTheme, setTheme, type Theme } from "../lib/theme.js";

export function renderSettings(container: HTMLElement, session: Session, onUpdated: () => void): void {
  const displayName = String(session.user.user_metadata?.display_name ?? "");
  const avatarUrl = session.user.user_metadata?.avatar_url as string | undefined;
  const currentTheme = getTheme();

  container.innerHTML = `
    <section class="settings-section">
      <h2>Profile</h2>
      <div class="avatar-row">
        <span class="account-avatar" id="avatar-preview">${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" />` : initials(displayName || session.user.email)}</span>
        <label style="flex:1;">
          Avatar image
          <input type="file" id="avatar-input" accept="image/png,image/jpeg,image/webp" />
        </label>
      </div>
      <form id="profile-form" class="stack">
        <label>
          Display name
          <input type="text" name="displayName" value="${escapeHtml(displayName)}" placeholder="${escapeHtml(session.user.email ?? "")}" />
        </label>
        <button type="submit">Save profile</button>
        <p id="profile-status" class="muted" hidden></p>
        <p id="profile-error" class="error" hidden></p>
      </form>
    </section>

    <section class="settings-section">
      <h2>Appearance</h2>
      <div class="theme-toggle">
        <button type="button" data-theme="dark" class="${currentTheme === "dark" ? "active" : ""}">Dark</button>
        <button type="button" data-theme="light" class="${currentTheme === "light" ? "active" : ""}">Light</button>
      </div>
    </section>

    <section class="settings-section">
      <h2>Account</h2>
      <p class="muted">Signed in as ${escapeHtml(session.user.email ?? session.user.id)}</p>
      <button type="button" id="settings-sign-out">Sign out</button>
    </section>
  `;

  container.querySelectorAll<HTMLButtonElement>(".theme-toggle button").forEach((button) => {
    button.addEventListener("click", () => {
      const theme = button.dataset.theme as Theme;
      setTheme(theme);
      container.querySelectorAll<HTMLButtonElement>(".theme-toggle button").forEach((b) => b.classList.toggle("active", b === button));
    });
  });

  container.querySelector<HTMLButtonElement>("#settings-sign-out")!.addEventListener("click", () => {
    void getSupabaseClient().auth.signOut();
  });

  const profileForm = container.querySelector<HTMLFormElement>("#profile-form")!;
  const profileStatus = container.querySelector<HTMLParagraphElement>("#profile-status")!;
  const profileError = container.querySelector<HTMLParagraphElement>("#profile-error")!;

  profileForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveProfile();
  });

  async function saveProfile(): Promise<void> {
    profileStatus.hidden = true;
    profileError.hidden = true;
    const name = String(new FormData(profileForm).get("displayName") ?? "").trim();
    const button = profileForm.querySelector<HTMLButtonElement>("button[type=submit]")!;
    button.disabled = true;
    try {
      const { error } = await getSupabaseClient().auth.updateUser({ data: { display_name: name } });
      if (error) throw error;
      profileStatus.textContent = "Saved.";
      profileStatus.hidden = false;
      onUpdated();
    } catch (error) {
      profileError.textContent = error instanceof Error ? error.message : "Could not save profile";
      profileError.hidden = false;
    } finally {
      button.disabled = false;
    }
  }

  const avatarInput = container.querySelector<HTMLInputElement>("#avatar-input")!;
  avatarInput.addEventListener("change", () => {
    const file = avatarInput.files?.[0];
    if (file) void uploadAvatar(file);
  });

  async function uploadAvatar(file: File): Promise<void> {
    profileError.hidden = true;
    try {
      const supabase = getSupabaseClient();
      const extension = file.name.split(".").pop() ?? "png";
      const path = `${session.user.id}/avatar.${extension}`;
      const { error: uploadError } = await supabase.storage.from("avatars").upload(path, file, { upsert: true, cacheControl: "3600" });
      if (uploadError) throw uploadError;
      const { data } = supabase.storage.from("avatars").getPublicUrl(path);
      // Cache-bust so the new image shows immediately even though the path is stable.
      const publicUrl = `${data.publicUrl}?t=${Date.now()}`;
      const { error: updateError } = await supabase.auth.updateUser({ data: { avatar_url: publicUrl } });
      if (updateError) throw updateError;
      onUpdated();
    } catch (error) {
      profileError.textContent = error instanceof Error ? error.message : "Could not upload avatar";
      profileError.hidden = false;
    }
  }
}

export function initials(source: string | undefined): string {
  if (!source) return "?";
  const trimmed = source.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length > 1) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
