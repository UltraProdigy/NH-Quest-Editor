// Redraw scheduling. The GUI is drawn on demand instead of every display frame: input, resizes
// and loaded images ask for a redraw, and anything that changes over time (pulsing colours,
// animated arrows, slide shows, lerps, wavy text) calls animating() while it draws, which keeps
// frames coming at a capped rate until the animation stops being drawn. Motion the viewer is
// driving (zoom and scroll lerps, opening trays) passes smooth = true and gets every display frame.

export const redraw = {
  /** Set during a frame by anything that will look different in the next one. */
  animating: false,
  /** Set during a frame by motion that should run at the display's full frame rate. */
  smooth: false,
  /** Installed by the screen host. */
  request: () => {},
  /** Number of the frame drawn last (counts up). */
  frame: 0,
};

/** Mark the frame being drawn as animated, so another one follows (at the display rate if smooth). */
export function animating(smooth = false) {
  redraw.animating = true;
  if (smooth) redraw.smooth = true;
}

/** Ask for a redraw (state changed outside of input the host already listens to). */
export function invalidate() {
  redraw.request();
}
