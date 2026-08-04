const copyButtons = document.querySelectorAll("[data-copy-target]");

copyButtons.forEach((copyButton) => {
  const targetEl = document.getElementById(copyButton.dataset.copyTarget);
  if (!targetEl) return;

  copyButton.addEventListener("click", async () => {
    const text = targetEl.textContent;
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
});

const revealEls = document.querySelectorAll(".reveal");
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (prefersReducedMotion) {
  revealEls.forEach((el) => el.classList.add("is-visible"));
} else {
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
  );

  revealEls.forEach((el) => revealObserver.observe(el));
}

// Pricing: monthly/annual toggle. Every price and caption carries both values as
// data-monthly/data-annual, so switching is a text swap with no layout shift.
const billingOptions = document.querySelectorAll("[data-billing]");

if (billingOptions.length > 0) {
  const priceEls = document.querySelectorAll("[data-monthly][data-annual]");

  billingOptions.forEach((option) => {
    option.addEventListener("click", () => {
      const period = option.dataset.billing;
      billingOptions.forEach((other) => other.classList.toggle("is-active", other === option));
      priceEls.forEach((el) => {
        const next = el.dataset[period];
        if (next) el.textContent = next;
      });
    });
  });
}
