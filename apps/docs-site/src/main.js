// Landing-page behaviour. Plain modules, no framework and no animation library:
// this site is Vite with hand-written HTML, CSS, and JS and stays that way.

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/* -- copy buttons -------------------------------------------------------- */

for (const button of document.querySelectorAll("[data-copy-target]")) {
  const target = document.getElementById(button.dataset.copyTarget);
  if (!target) continue;

  button.addEventListener("click", async () => {
    const text = target.textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API needs a secure context; fall back to the old selection path.
      const scratch = document.createElement("textarea");
      scratch.value = text;
      scratch.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(scratch);
      scratch.select();
      document.execCommand("copy");
      scratch.remove();
    }

    const label = button.textContent;
    button.textContent = "Copied";
    button.classList.add("is-copied");
    setTimeout(() => {
      button.textContent = label;
      button.classList.remove("is-copied");
    }, 1600);
  });
}

/* -- mobile nav ---------------------------------------------------------- */

const navToggle = document.querySelector(".nav-toggle");
const navLinks = document.querySelector("#nav-links");

if (navToggle && navLinks) {
  navToggle.addEventListener("click", () => {
    const open = navLinks.classList.toggle("is-open");
    navToggle.setAttribute("aria-expanded", String(open));
  });

  for (const link of navLinks.querySelectorAll("a")) {
    link.addEventListener("click", () => {
      navLinks.classList.remove("is-open");
      navToggle.setAttribute("aria-expanded", "false");
    });
  }
}

/* -- scroll reveal ------------------------------------------------------- */

const revealEls = document.querySelectorAll(".reveal");

if (reduceMotion.matches) {
  for (const el of revealEls) el.classList.add("is-visible");
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
  );

  for (const el of revealEls) observer.observe(el);
}

/* -- pricing period toggle ----------------------------------------------- */
// Every price and caption carries both values as data-monthly/data-annual, so
// switching periods is a text swap and never reflows the card grid.

const billingOptions = document.querySelectorAll("[data-billing]");

if (billingOptions.length > 0) {
  const priceEls = document.querySelectorAll("[data-monthly][data-annual]");

  for (const option of billingOptions) {
    option.addEventListener("click", () => {
      const period = option.dataset.billing;
      for (const other of billingOptions) {
        const active = other === option;
        other.classList.toggle("is-active", active);
        other.setAttribute("aria-pressed", String(active));
      }
      for (const el of priceEls) {
        const next = el.dataset[period];
        if (next) el.textContent = next;
      }
    });
  }
}

/* -- the animated loop --------------------------------------------------- */
// One [data-step] attribute on .scene drives every transition in CSS. This file
// only advances the number, which is what makes pausing and reduced motion
// cheap: stop advancing, or jump straight to the finished frame.

const scene = document.querySelector("#scene");

if (scene) {
  const toggle = scene.querySelector("[data-scene-toggle]");
  const toggleLabel = toggle?.querySelector(".scene-toggle-label");

  // Step 0 is the idle frame; 5 holds the finished state before looping.
  const TIMINGS = [700, 1700, 1950, 1500, 3000, 2400];

  let step = 0;
  let timer = null;
  let onScreen = false;
  let userPaused = false;

  const running = () => !userPaused && onScreen && !document.hidden;

  function schedule() {
    clearTimeout(timer);
    if (!running()) return;
    timer = setTimeout(() => {
      step = (step + 1) % TIMINGS.length;
      scene.dataset.step = String(step);
      schedule();
    }, TIMINGS[step]);
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  if (reduceMotion.matches) {
    // Nothing animates, so render the frame that shows the whole story at once:
    // the edit made, the payload sealed, the proposal received and accepted.
    scene.dataset.step = "done";
  } else {
    const sceneObserver = new IntersectionObserver(
      (entries) => {
        onScreen = entries[0].isIntersecting;
        if (running()) schedule();
        else stop();
      },
      { threshold: 0.25 }
    );
    sceneObserver.observe(scene);

    document.addEventListener("visibilitychange", () => {
      if (running()) schedule();
      else stop();
    });

    toggle?.addEventListener("click", () => {
      userPaused = !userPaused;
      toggle.setAttribute("aria-pressed", String(userPaused));
      if (toggleLabel) toggleLabel.textContent = userPaused ? "Play" : "Pause";
      if (running()) schedule();
      else stop();
    });
  }
}
