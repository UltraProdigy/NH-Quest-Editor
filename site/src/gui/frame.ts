// Redraw scheduling. The GUI is drawn on demand instead of every display frame: input, resizes
// and loaded images ask for a redraw, and anything that changes over time (pulsing colours,
// animated arrows, slide shows, lerps, wavy text) calls animating() while it draws, which keeps
// frames coming at a capped rate until the animation stops being drawn.

export const redraw = {
  /** Set during a frame by anything that will look different in the next one. */
  animating: false,
  /** Installed by the screen host. */
  request: () => {},
};

/** Mark the frame being drawn as animated, so another one follows. */
export function animating() {
  redraw.animating = true;
}

/** Ask for a redraw (state changed outside of input the host already listens to). */
export function invalidate() {
  redraw.request();
}
