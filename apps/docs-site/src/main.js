// Landing-page behaviour: copy buttons, the mobile nav, the FAQ, and the product
// scene's own state machine. Still no framework and still hand-written HTML and
// CSS. Motion is the one thing delegated, to GSAP, through src/motion.js, which
// this file starts at the bottom once the scene has a controller to hand over.

import { init as initMotion } from "./landing-motion.js";

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
    button.textContent = "copied";
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

/* -- the animated loop --------------------------------------------------- */
// One [data-step] attribute on .scene drives every transition in CSS. This file
// only advances the number, which is what makes pausing and reduced motion
// cheap: stop advancing, or jump straight to the finished frame.

const scene = document.querySelector("#scene");
let sceneController = null;

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
  // Set when the pinned scroll sequence takes ownership of the scene. The timer
  // then stops scheduling entirely rather than racing the scrubbed frame.
  let handedOver = false;

  const running = () => !handedOver && !userPaused && onScreen && !document.hidden;

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
      if (toggleLabel) toggleLabel.textContent = "play";
      stop();
      paint();
    });
  }

  // Handed to src/landing-motion.js, which drives the same steps from scroll on a
  // wide viewport. Everywhere else the timer below keeps running as it always has.
  sceneController = {
    weights: TIMINGS,
    setStep(next) {
      step = next;
      paint();
    },
    suspend() {
      handedOver = true;
      stop();
    },
    resume() {
      handedOver = false;
      if (running()) schedule();
    },
  };

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
      if (toggleLabel) toggleLabel.textContent = userPaused ? "play" : "pause";
      if (running()) schedule();
      else stop();
    });
  }
}

/* -- motion -------------------------------------------------------------- */

// Last, and with the scene controller in hand: everything above is behaviour the
// page needs whether or not a tween ever runs, and none of it should be waiting
// on an animation library to finish parsing.
initMotion({ scene: sceneController });
