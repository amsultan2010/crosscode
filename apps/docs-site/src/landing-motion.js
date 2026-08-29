/* ==========================================================================
   Landing-page choreography.

   Every behaviour on the page is built here, inside one gsap.matchMedia() so
   that desktop, mobile, and reduced motion are three separate designs rather
   than one design scaled down. main.js calls init() once, after it has wired up
   the non-motion behaviour, and hands over a controller for the product scene so
   the two do not both try to drive it.

   The vocabulary is deliberately not one shared fade-up applied to everything:
   display type is split and masked, media is clipped, rules draw themselves,
   cards stagger, numbers and logs cascade, and the pointer is answered before
   any click happens.
   ========================================================================== */

import { gsap, ScrollTrigger, ScrollToPlugin, SplitText, D, E, ENTER, openStage, revealLines, revealWords } from "./motion.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * @param {object} opts
 * @param {{ setStep(step: number|string): void, suspend(): void, resume(): void, steps: number }} [opts.scene]
 *   Controller handed over by main.js. When the pinned sequence takes the scene,
 *   it suspends the timer first so a scrubbed frame is not fighting a scheduled one.
 */
export function init({ scene: sceneCtl } = {}) {
  const mm = gsap.matchMedia();

  mm.add(
    {
      desk: "(min-width: 64rem)",
      wide: "(min-width: 48rem)",
      hover: "(hover: hover) and (pointer: fine)",
      ok: "(prefers-reduced-motion: no-preference)",
    },
    (ctx) => {
      const { desk, wide, hover, ok } = ctx.conditions;

      if (!ok) {
        // Reduced motion: every element is simply present. No travel, no scrub,
        // no pin, and the scene renders the frame that tells the whole story.
        gsap.set("[data-anim]", { clearProps: "all", opacity: 1, x: 0, y: 0, scale: 1, clipPath: "none" });
        gsap.set(".marquee-track", { opacity: 1 });
        sceneCtl?.setStep("done");
        openStage();
        return;
      }

      // The staging class comes off first, before any from() is built: a from()
      // records the element's current computed value as its destination, and
      // while the gate is still applied that value is opacity 0. Nothing paints
      // between here and the end of this function, so removing it early costs
      // no flash and saves every entrance from animating to invisible.
      openStage();

      buildHeader();
      buildHero({ desk });
      buildMarquee();
      buildStage({ sceneCtl, desk });
      buildSectionHeads();
      buildFeatures();
      buildSeals();
      buildPricing();
      buildInstall();
      buildFaq();
      buildClose({ wide });
      buildFooter();
      buildAnchors();
      buildAmbient();

      if (hover) {
        buildCursor();
        buildMagnets();
        buildTilt();
        buildLinkHovers();
      }

      ScrollTrigger.refresh();
    }
  );

  // Fonts land after first paint and change every line box, so anything measured
  // from layout has to be remeasured. SplitText's autoSplit handles the splits;
  // this catches the triggers that were positioned against them.
  document.fonts?.ready.then(() => ScrollTrigger.refresh());

  return () => mm.revert();
}

/* -- header --------------------------------------------------------------- */

function buildHeader() {
  const header = $(".site-header");
  if (!header) return;

  // A hairline under the sticky bar, scrubbed against document progress. It is
  // decorative: it reports where you are, it never carries information you need.
  const rule = document.createElement("div");
  rule.className = "scroll-rule";
  rule.setAttribute("aria-hidden", "true");
  header.appendChild(rule);

  gsap.to(rule, {
    scaleX: 1,
    ease: E.none,
    scrollTrigger: { start: 0, end: "max", scrub: 0.4 },
  });

  // The header sits transparent over the hero and takes its border and blur only
  // once there is content behind it to separate from.
  gsap.fromTo(
    header,
    { "--header-veil": 0 },
    {
      "--header-veil": 1,
      ease: E.none,
      scrollTrigger: { start: 10, end: 220, scrub: 0.5 },
    }
  );
}

/* -- hero ----------------------------------------------------------------- */

function buildHero({ desk }) {
  const hero = $(".hero");
  if (!hero) return;

  const tl = gsap.timeline({ defaults: { ease: E.out } });

  // 1. The rule under the project meta draws itself from the left before
  //    anything else moves. Its width is a variable feeding background-size, so
  //    the line grows without the two links sitting on it being squashed.
  tl.set(".meta-row", { opacity: 1 }, 0)
    .fromTo(".meta-row", { "--rule": 0 }, { "--rule": 1, duration: D.mid, ease: E.out }, 0)
    .from(".meta-item", { yPercent: 60, opacity: 0, duration: D.mid, stagger: 0.07 }, 0.12);

  // 2. The display headline is split to words inside line masks and lifted out
  //    from below, with a touch of rotation so the cascade has a direction.
  revealWords($(".hero h1"), { start: "top 95%", stagger: 0.035 });

  // 3. The lede is split to lines, not words: it is a sentence, and a per-word
  //    cascade on a sentence reads as a gimmick rather than as emphasis.
  revealLines($(".hero-lede"), { start: "top 95%", delay: 0.18, stagger: 0.07 });

  // 4. Everything below the fold line of the hero rises together on a tight
  //    stagger, which reads as one block arriving rather than six things.
  tl.from(
    [".hero-byline", ".hero-actions", ".hero-foot"],
    { y: 22, opacity: 0, duration: D.mid, stagger: 0.08 },
    0.45
  );

  // 5. The command bar wipes open rather than fading: it is a piece of terminal
  //    chrome, and a wipe is the gesture a terminal makes.
  tl.from(
    ".hero-cmd",
    { clipPath: "inset(0 100% 0 0)", opacity: 1, duration: D.slow, ease: E.out },
    0.5
  ).from(".hero-cmd > *", { opacity: 0, duration: D.base, stagger: 0.08 }, 0.85);

  // 6. Parallax rate one of three: the graph paper behind the hero drifts slower
  //    than the copy on top of it and dims as it goes.
  if (desk) {
    gsap.to(".hero-grid", {
      yPercent: 16,
      opacity: 0.35,
      ease: E.none,
      scrollTrigger: { trigger: hero, start: "top top", end: "bottom top", scrub: 0.6 },
    });
  }
}

/* -- the marquee ---------------------------------------------------------- */

function buildMarquee() {
  const track = $(".marquee-track");
  if (!track) return;

  // A seamless loop needs two copies of the content and a tween that travels
  // exactly half the track. The clone is hidden from assistive technology so the
  // agent names are announced once, not twice.
  const clone = track.cloneNode(true);
  clone.setAttribute("aria-hidden", "true");
  for (const el of clone.children) el.setAttribute("aria-hidden", "true");
  while (clone.firstChild) track.appendChild(clone.firstChild);

  gsap.set(track, { opacity: 1 });

  const loop = gsap.to(track, {
    xPercent: -50,
    duration: 38,
    ease: E.none,
    repeat: -1,
  });

  // Off-screen it should not be burning frames, and hovering it slows rather
  // than stops, so the row still reads as live while you look at it.
  ScrollTrigger.create({
    trigger: track,
    start: "top bottom",
    end: "bottom top",
    onToggle: (self) => (self.isActive ? loop.play() : loop.pause()),
  });

  const marquee = track.closest(".marquee");
  marquee?.addEventListener("pointerenter", () => gsap.to(loop, { timeScale: 0.25, duration: D.base }));
  marquee?.addEventListener("pointerleave", () => gsap.to(loop, { timeScale: 1, duration: D.base }));
}

/* -- the pinned set piece -------------------------------------------------- */

function buildStage({ sceneCtl, desk }) {
  const stage = $(".stage");
  const scene = $("#scene");
  if (!stage || !scene) return;

  // The stage itself arrives as media: clipped open from the bottom with the
  // panels overscaled behind the clip, so it uncovers rather than fades.
  gsap.from(stage, {
    clipPath: "inset(0 0 100% 0)",
    duration: D.epic,
    ease: E.out,
    scrollTrigger: { trigger: stage, start: "top 88%", once: true },
  });
  gsap.from(".scene-grid", {
    scale: 1.06,
    duration: D.epic,
    ease: E.out,
    scrollTrigger: { trigger: stage, start: "top 88%", once: true },
  });
  gsap.from(".stage-tab", {
    y: 14,
    opacity: 0,
    duration: D.base,
    stagger: 0.05,
    scrollTrigger: { trigger: ".stage-tabs", start: "top 92%", once: true },
  });

  // Below the desktop breakpoint the section scrolls normally and main.js keeps
  // its timer: pinning a tall two-panel diagram on a phone costs the reader
  // control of the page and gives nothing back.
  if (!desk || !sceneCtl) return;

  const wrap = stage.closest(".wrap") ?? stage;
  wrap.classList.add("stage-pin");

  const bar = document.createElement("div");
  bar.className = "stage-progress";
  bar.setAttribute("aria-hidden", "true");
  bar.innerHTML = "<span></span>";
  stage.appendChild(bar);

  // Scroll now drives the sequence, so the timer must let go of it or a scrubbed
  // frame and a scheduled frame will fight over the same attribute.
  sceneCtl.suspend();

  // Segment weights are the timer's own step durations, so scrolling the
  // sequence spends time on each step in the proportions it was designed with.
  const weights = sceneCtl.weights ?? [1, 1, 1, 1, 1, 1];
  const total = weights.reduce((a, b) => a + b, 0);
  const bounds = [];
  let acc = 0;
  for (const w of weights) {
    acc += w;
    bounds.push(acc / total);
  }

  let painted = -1;

  const st = ScrollTrigger.create({
    trigger: wrap,
    start: "center center",
    end: "+=2600",
    pin: true,
    // Smoothing, so the sequence eases between steps instead of snapping to
    // scroll ticks and reading as a stutter.
    scrub: 0.8,
    anticipatePin: 1,
    invalidateOnRefresh: true,
    onEnter: () => gsap.to(bar, { opacity: 1, duration: D.base }),
    onEnterBack: () => gsap.to(bar, { opacity: 1, duration: D.base }),
    onLeave: () => gsap.to(bar, { opacity: 0, duration: D.base }),
    onLeaveBack: () => gsap.to(bar, { opacity: 0, duration: D.base }),
    onUpdate: (self) => {
      gsap.set(bar.firstElementChild, { scaleX: self.progress });
      let step = bounds.findIndex((b) => self.progress < b);
      if (step === -1) step = weights.length - 1;
      if (step !== painted) {
        painted = step;
        sceneCtl.setStep(step);
      }
    },
  });

  // The pause button paused a timer that is no longer running, so it goes. The
  // tabs stay useful by becoming jumps into the scroll: clicking one scrolls to
  // where that step begins, which is the only way to reach it now.
  $(".scene-toggle", stage)?.remove();

  for (const tab of $$("[data-step-tab]", stage)) {
    const n = Number(tab.dataset.stepTab);
    const at = n === 0 ? 0 : (bounds[n - 1] + bounds[n]) / 2;
    tab.addEventListener("click", () => {
      gsap.to(window, {
        duration: D.slow,
        ease: E.inOut,
        scrollTo: { y: st.start + (st.end - st.start) * at, autoKill: true },
      });
    });
  }
}

/* -- section heads --------------------------------------------------------- */

function buildSectionHeads() {
  for (const head of $$(".section-head")) {
    const kicker = $(".kicker", head);
    const h2 = $("h2", head);
    const lede = $(".lede", head);

    if (kicker) {
      gsap.from(kicker, {
        yPercent: 100,
        opacity: 0,
        duration: D.base,
        scrollTrigger: { trigger: head, start: ENTER, once: true },
      });
    }

    revealWords(h2, { start: ENTER, trigger: head, delay: 0.06 });
    revealLines(lede, { start: ENTER, delay: 0.24, stagger: 0.06 });
  }
}

/* -- features -------------------------------------------------------------- */

function buildFeatures() {
  const rows = $$(".feature-list li");
  if (!rows.length) return;

  // Batched rather than one trigger per row: the visual result is the same
  // cascade and it is a single set of measurements instead of eight.
  ScrollTrigger.batch(rows, {
    start: "top 90%",
    once: true,
    onEnter: (batch) =>
      gsap.from(batch, {
        y: 34,
        opacity: 0,
        duration: D.mid,
        stagger: { each: 0.06, from: "start" },
        ease: E.out,
      }),
  });

  // The lead-in phrase of each row gets its own faster pass, so the row's first
  // few words land before the sentence behind them settles.
  ScrollTrigger.batch($$(".feature-list b"), {
    start: "top 90%",
    once: true,
    onEnter: (batch) =>
      gsap.from(batch, { yPercent: 40, opacity: 0, duration: D.base, stagger: 0.04 }),
  });
}

/* -- the guarantee and privacy cards --------------------------------------- */

function buildSeals() {
  for (const grid of $$(".seal-grid")) {
    const cards = $$(".seal", grid);

    gsap.from(cards, {
      y: 46,
      scale: 0.985,
      opacity: 0,
      duration: D.mid,
      stagger: 0.07,
      ease: E.out,
      scrollTrigger: { trigger: grid, start: "top 88%", once: true },
    });

    // Each card's heading rule draws itself left to right rather than appearing.
    gsap.fromTo($$(".seal h3", grid), { "--rule": 0 }, {
      "--rule": 1,
      duration: D.slow,
      stagger: 0.07,
      delay: 0.2,
      ease: E.out,
      scrollTrigger: { trigger: grid, start: "top 88%", once: true },
    });

    // List items inside a card cascade after the card itself has landed.
    for (const card of cards) {
      const items = $$("li", card);
      if (!items.length) continue;
      gsap.from(items, {
        x: -12,
        opacity: 0,
        duration: D.base,
        stagger: 0.05,
        delay: 0.25,
        scrollTrigger: { trigger: card, start: "top 88%", once: true },
      });
    }
  }
}

/* -- pricing --------------------------------------------------------------- */

function buildPricing() {
  const strip = $(".plan-strip");
  if (!strip) return;

  gsap.set(strip, { opacity: 1 });
  gsap.fromTo(strip, { "--rule": 0 }, {
    "--rule": 1,
    duration: D.slow,
    ease: E.out,
    scrollTrigger: { trigger: strip, start: "top 90%", once: true },
  });

  gsap.from(strip.children, {
    y: 28,
    opacity: 0,
    duration: D.mid,
    stagger: 0.08,
    delay: 0.2,
    scrollTrigger: { trigger: strip, start: "top 90%", once: true },
  });
}

/* -- install --------------------------------------------------------------- */

function buildInstall() {
  for (const panel of $$("#install .install-panel")) {
    gsap.from(panel, {
      clipPath: "inset(0 0 100% 0)",
      duration: D.epic,
      ease: E.out,
      scrollTrigger: { trigger: panel, start: "top 88%", once: true },
    });

    // The prompt reads as something being written into the panel rather than
    // something that was always there.
    const code = $("code", panel);
    if (code) {
      gsap.from(code, {
        opacity: 0,
        y: 16,
        duration: D.mid,
        delay: 0.3,
        scrollTrigger: { trigger: panel, start: "top 88%", once: true },
      });
    }
  }

  const disclose = $("#install .disclose");
  if (disclose) {
    gsap.from(disclose, {
      scaleY: 0.9,
      opacity: 0,
      transformOrigin: "top center",
      duration: D.mid,
      scrollTrigger: { trigger: disclose, start: "top 92%", once: true },
    });
  }
}

/* -- faq ------------------------------------------------------------------- */

function buildFaq() {
  const items = $$(".faq-item");
  if (!items.length) return;

  ScrollTrigger.batch(items, {
    start: "top 92%",
    once: true,
    onEnter: (batch) =>
      gsap.from(batch, {
        y: 24,
        opacity: 0,
        duration: D.base,
        stagger: 0.05,
        ease: E.out,
      }),
  });

  // <details> jumps its own height open and shut. Tweening the body height turns
  // that jump into a movement, and the marker rotates rather than swapping glyph.
  for (const item of items) {
    const body = $(".faq-body", item);
    if (!body) continue;
    item.addEventListener("toggle", () => {
      gsap.killTweensOf(body);
      if (item.open) {
        gsap.from(body, { height: 0, opacity: 0, duration: D.base, ease: E.inOut, clearProps: "height" });
      }
    });
  }
}

/* -- closing statement ----------------------------------------------------- */

function buildClose({ wide }) {
  const close = $(".close");
  if (!close) return;

  revealWords($(".close h2"), { start: "top 88%", stagger: 0.04 });
  revealLines($(".close .lede"), { start: "top 88%", delay: 0.2 });

  gsap.from(".close .hero-cmd", {
    clipPath: "inset(0 100% 0 0)",
    duration: D.slow,
    scrollTrigger: { trigger: close, start: "top 82%", once: true },
  });

  // Parallax rate two of three: the closing headline drifts against the section
  // it sits in, so the last screen is not static while you read it.
  if (wide) {
    gsap.fromTo(
      ".close .wrap",
      { yPercent: 6 },
      {
        yPercent: -4,
        ease: E.none,
        scrollTrigger: { trigger: close, start: "top bottom", end: "bottom top", scrub: 0.7 },
      }
    );
  }
}

/* -- footer ---------------------------------------------------------------- */

function buildFooter() {
  const grid = $(".footer-grid");
  if (!grid) return;

  gsap.from($$(".footer-brand, .footer-col", grid), {
    y: 26,
    opacity: 0,
    duration: D.mid,
    stagger: 0.07,
    scrollTrigger: { trigger: grid, start: "top 95%", once: true },
  });

  gsap.from($$(".footer-col a", grid), {
    opacity: 0,
    duration: D.base,
    stagger: 0.015,
    delay: 0.2,
    scrollTrigger: { trigger: grid, start: "top 95%", once: true },
  });
}

/* -- in-page anchors ------------------------------------------------------- */

function buildAnchors() {
  // ScrollToPlugin rather than CSS scroll-behavior: a pinned section changes the
  // document height, and ScrollTrigger knows where a target actually sits once
  // pinning is accounted for. The CSS smooth scroll stays as the no-JS fallback.
  for (const link of $$('a[href^="#"]')) {
    const id = link.getAttribute("href");
    if (id.length < 2 || !$(id)) continue;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      gsap.to(window, {
        duration: D.slow,
        ease: E.inOut,
        scrollTo: { y: id, offsetY: 72, autoKill: true },
      });
      // The URL should still change, so the link can be copied and shared.
      history.pushState(null, "", id);
    });
  }
}

/* -- ambient --------------------------------------------------------------- */

// After the entrances finish, the page is still alive. Low amplitude, long
// durations: this should be felt at the edge of attention, never watched.
function buildAmbient() {
  gsap.to(".dot-live", {
    opacity: 0.45,
    scale: 0.82,
    duration: 1.4,
    repeat: -1,
    yoyo: true,
    ease: E.inOut,
    stagger: 0.4,
  });

  // Parallax rate three of three: the terminal panels drift a little against the
  // page as it scrolls, at a rate that matches neither the grid nor the closer.
  gsap.to(".panel", {
    yPercent: -2.5,
    ease: E.none,
    scrollTrigger: { trigger: ".scene", start: "top bottom", end: "bottom top", scrub: 1.2 },
  });

  // The wire between the two checkouts breathes even when no packet is crossing
  // it, so the link reads as open rather than as a drawn line.
  gsap.to(".wire-track", {
    opacity: 0.45,
    duration: 2.6,
    repeat: -1,
    yoyo: true,
    ease: E.inOut,
  });
}

/* -- pointer layer ---------------------------------------------------------
   Everything below is built only under (hover: hover) and (pointer: fine), so a
   touch device never runs a pointermove handler it cannot benefit from.
   ------------------------------------------------------------------------- */

function buildCursor() {
  const ring = document.createElement("div");
  ring.className = "cursor";
  ring.setAttribute("aria-hidden", "true");
  ring.innerHTML = '<span class="cursor-label"></span>';
  const dot = document.createElement("div");
  dot.className = "cursor-dot";
  dot.setAttribute("aria-hidden", "true");
  document.body.append(ring, dot);
  // Only once the replacement is actually in the document does the native arrow
  // go away, so a module that failed to load never leaves the page cursorless.
  document.documentElement.classList.add("has-cursor");

  const label = $(".cursor-label", ring);

  // quickTo, not a tween per event: pointermove fires at the display's refresh
  // rate and creating a tween each time is how a cursor starts dropping frames.
  const rx = gsap.quickTo(ring, "x", { duration: 0.45, ease: "power3" });
  const ry = gsap.quickTo(ring, "y", { duration: 0.45, ease: "power3" });
  const dx = gsap.quickTo(dot, "x", { duration: 0.1, ease: "power3" });
  const dy = gsap.quickTo(dot, "y", { duration: 0.1, ease: "power3" });

  let shown = false;
  window.addEventListener("pointermove", (e) => {
    rx(e.clientX);
    ry(e.clientY);
    dx(e.clientX);
    dy(e.clientY);
    if (!shown) {
      shown = true;
      gsap.to([ring, dot], { opacity: 1, duration: D.base });
    }
  });

  document.addEventListener("pointerleave", () => {
    shown = false;
    gsap.to([ring, dot], { opacity: 0, duration: D.base });
  });

  // Over something you can act on, the ring grows and says what will happen.
  const targets = "a, button, summary, .chips li, .marquee-item";
  for (const el of $$(targets)) {
    const text = el.dataset.cursor ?? (el.tagName === "SUMMARY" ? "open" : "");
    el.addEventListener("pointerenter", () => {
      label.textContent = text;
      gsap.to(ring, { scale: text ? 2.1 : 1.75, borderColor: "rgba(237,238,242,0.9)", duration: D.base });
      gsap.to(label, { opacity: text ? 1 : 0, duration: D.base });
      gsap.to(dot, { scale: 0, duration: D.base });
    });
    el.addEventListener("pointerleave", () => {
      gsap.to(ring, { scale: 1, borderColor: "rgba(237,238,242,0.42)", duration: D.base });
      gsap.to(label, { opacity: 0, duration: D.fast });
      gsap.to(dot, { scale: 1, duration: D.base });
    });
  }
}

function buildMagnets() {
  for (const btn of $$(".btn-lg, .btn-primary, .copy-btn")) {
    const xTo = gsap.quickTo(btn, "x", { duration: 0.4, ease: "power3" });
    const yTo = gsap.quickTo(btn, "y", { duration: 0.4, ease: "power3" });
    const pull = btn.classList.contains("btn-lg") ? 0.32 : 0.2;

    btn.addEventListener("pointermove", (e) => {
      const r = btn.getBoundingClientRect();
      xTo((e.clientX - (r.left + r.width / 2)) * pull);
      yTo((e.clientY - (r.top + r.height / 2)) * pull);
    });
    btn.addEventListener("pointerleave", () => {
      xTo(0);
      yTo(0);
    });
  }
}

function buildTilt() {
  for (const card of $$(".seal, .install-panel")) {
    card.parentElement?.classList.add("tilt-wrap");
    card.classList.add("tilt");

    const rxTo = gsap.quickTo(card, "rotationX", { duration: 0.5, ease: "power3" });
    const ryTo = gsap.quickTo(card, "rotationY", { duration: 0.5, ease: "power3" });

    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      rxTo((-(e.clientY - (r.top + r.height / 2)) / r.height) * 7);
      ryTo(((e.clientX - (r.left + r.width / 2)) / r.width) * 7);
    });
    card.addEventListener("pointerleave", () => {
      rxTo(0);
      ryTo(0);
    });
  }
}

function buildLinkHovers() {
  // A choreographed hover: the label leaves upward while its copy arrives from
  // below, which CSS cannot express as one reversible gesture. Simple colour and
  // opacity hovers elsewhere on the page stay in CSS, where they belong.
  for (const link of $$(".footer-col a, .nav-links > a:not(.btn):not(.nav-ghost)")) {
    if (link.querySelector(".hov-in")) continue;
    const text = link.textContent.trim();
    link.textContent = "";
    link.style.overflow = "hidden";
    link.style.display = "inline-block";
    link.style.verticalAlign = "bottom";

    const a = document.createElement("span");
    a.className = "hov-in";
    a.textContent = text;
    a.style.display = "block";
    const b = document.createElement("span");
    b.className = "hov-out";
    b.textContent = text;
    b.setAttribute("aria-hidden", "true");
    b.style.display = "block";
    link.append(a, b);

    const tl = gsap
      .timeline({ paused: true })
      .to([a, b], { yPercent: -100, duration: D.base, ease: E.inOut });

    link.addEventListener("pointerenter", () => tl.play());
    link.addEventListener("pointerleave", () => tl.reverse());
    link.addEventListener("focus", () => tl.play());
    link.addEventListener("blur", () => tl.reverse());
  }
}
