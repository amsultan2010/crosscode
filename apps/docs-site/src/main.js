const copyButton = document.getElementById("copy-install-prompt");
const promptEl = document.getElementById("install-prompt-text");

if (copyButton && promptEl) {
  copyButton.addEventListener("click", async () => {
    const text = promptEl.textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }

    const originalLabel = copyButton.textContent;
    copyButton.textContent = "Copied!";
    copyButton.classList.add("copied");
    setTimeout(() => {
      copyButton.textContent = originalLabel;
      copyButton.classList.remove("copied");
    }, 1800);
  });
}
