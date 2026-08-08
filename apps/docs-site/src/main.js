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

/* -- faq hover ----------------------------------------------------------- */

// With a mouse, hovering a question opens it, so scanning the whole list costs no
// clicks. Touch and keyboard keep the plain <details> click behaviour: a hover that
// only fires after a tap would just be a slower click. A question opened by hand is
// left alone until the pointer leaves it.
const hoverPointer = window.matchMedia("(hover: hover) and (pointer: fine)");

for (const item of document.querySelectorAll(".faq-item")) {
  item.addEventListener("mouseenter", () => {
    if (hoverPointer.matches) item.open = true;
  });
  item.addEventListener("mouseleave", () => {
    if (hoverPointer.matches && !item.contains(document.activeElement)) item.open = false;
  });
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
  const stage = scene.closest(".stage") ?? document;
  const toggle = stage.querySelector("[data-scene-toggle]");
  const toggleLabel = toggle?.querySelector(".scene-toggle-label");
  const tabs = [...stage.querySelectorAll("[data-step-tab]")];

  // Step 0 is the idle frame; 5 holds the finished state before looping.
  const TIMINGS = [700, 1700, 1950, 1500, 3000, 2400];

  // The tab strip labels steps 1 through 4. Step 5 is the settled frame that
  // follows the accept, so it keeps the last tab lit rather than going dark.
  const TAB_FOR_STEP = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 4, done: 4 };

  let step = 0;
  let timer = null;
  let onScreen = false;
  let userPaused = false;

  const running = () => !userPaused && onScreen && !document.hidden;

  function paint() {
    scene.dataset.step = String(step);
    const active = TAB_FOR_STEP[step];
    for (const tab of tabs) {
      // aria-pressed, not aria-selected: the strip was marked up as a tablist but has
      // no tabpanels and no arrow-key navigation, so it promised a widget it is not.
      // It is a group of toggle buttons that drive one scene, and says so now.
      tab.setAttribute("aria-pressed", String(Number(tab.dataset.stepTab) === active));
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (!running()) return;
    timer = setTimeout(() => {
      step = (step + 1) % TIMINGS.length;
      paint();
      schedule();
    }, TIMINGS[step]);
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  // Clicking a tab drives the scene by hand, which also pauses the loop so the
  // frame you asked for is the frame you keep looking at.
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      step = Number(tab.dataset.stepTab);
      userPaused = true;
      toggle?.setAttribute("aria-pressed", "true");
      if (toggleLabel) toggleLabel.textContent = "Play";
      stop();
      paint();
    });
  }

  if (reduceMotion.matches) {
    // Nothing animates, so render the frame that shows the whole story at once:
    // the edit made, the payload sealed, the proposal received and accepted.
    step = "done";
    paint();
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
