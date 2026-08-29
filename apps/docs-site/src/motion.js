/* ==========================================================================
   The site's one motion module.

   Nothing else imports "gsap" directly. Plugin registration, the easing curves,
   and the duration scale all live here, which is what keeps a hover on the nav
   and a pinned scroll sequence feeling like they were designed by the same
   hand. The duration and easing numbers mirror --d-* and --e-* in style.css, so
   a value is the same whether it is spent in CSS or in a tween.
   ========================================================================== */

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ScrollToPlugin } from "gsap/ScrollToPlugin";
import { SplitText } from "gsap/SplitText";
import { CustomEase } from "gsap/CustomEase";

gsap.registerPlugin(ScrollTrigger, ScrollToPlugin, SplitText, CustomEase);

// Two signature curves, named once and used everywhere, rather than a different
// inline cubic-bezier guessed at each call site. "out" is the site's primary and
// carries every entrance; "inOut" is for anything that has to run backwards,
// which is every hover timeline.
CustomEase.create("out", "0.16, 1, 0.3, 1");
CustomEase.create("inOut", "0.65, 0, 0.35, 1");

/** Durations. Travel distance picks the number: a 4px nudge takes `fast`, a
 *  full-height masked line takes `slow`. */
export const D = { fast: 0.22, base: 0.4, mid: 0.7, slow: 1.05, epic: 1.5 };

export const E = { out: "out", inOut: "inOut", none: "none" };

gsap.defaults({ ease: E.out, duration: D.mid });

// One-shot entrances all fire here. Late enough that the element is genuinely on
// screen when it moves, rather than at "top 100%" where it animates off-screen
// and the reader arrives to find it already finished.
export const ENTER = "top 85%";

/**
 * Removes the staging class that style.css uses to pre-hide animated elements.
 * Called by whoever finishes building the timelines, and by a failsafe in the
 * document head if this module never arrives, so a JS failure can never leave
 * the page invisible.
 */
export function openStage() {
  document.documentElement.classList.remove("motion-pending");
}

/**
 * Splits an element into masked lines and returns the tween, letting `autoSplit`
 * re-split and re-run it when a webfont lands or the box is resized. SplitText
 * keeps the original text available to assistive technology itself, so there is
 * no aria-hidden clone to maintain.
 */
export function revealLines(el, { start = ENTER, stagger = 0.075, delay = 0, y = 108 } = {}) {
  if (!el) return null;
  return SplitText.create(el, {
    type: "lines",
    mask: "lines",
    autoSplit: true,
    linesClass: "split-line",
    onSplit(self) {
      return gsap.from(self.lines, {
        yPercent: y,
        duration: D.slow,
        stagger,
        delay,
        ease: E.out,
        scrollTrigger: { trigger: el, start, once: true },
      });
    },
  });
}

/**
 * The same treatment at word granularity, for display headings where the
 * per-word cascade is the point. Never use this on body copy: splitting a long
 * paragraph is expensive and gives a screen reader nothing.
 */
export function revealWords(el, { start = ENTER, stagger = 0.028, delay = 0, trigger } = {}) {
  if (!el) return null;
  return SplitText.create(el, {
    type: "lines,words",
    mask: "lines",
    autoSplit: true,
    linesClass: "split-line",
    onSplit(self) {
      return gsap.from(self.words, {
        yPercent: 116,
        rotate: 2.5,
        duration: D.slow,
        stagger,
        delay,
        ease: E.out,
        scrollTrigger: { trigger: trigger ?? el, start, once: true },
      });
    },
  });
}

// The motion system is bundled, not global, so nothing on the page can reach it
// by accident. This handle is the deliberate exception: it makes the site's own
// motion inspectable from a console, which is how the trigger count, the pin,
// and the scrub smoothing above were measured rather than assumed.
window.__motion = { gsap, ScrollTrigger, D, E };

export { gsap, ScrollTrigger, ScrollToPlugin, SplitText, CustomEase };
