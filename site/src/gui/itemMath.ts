// Pure maths for drawing item icons like the game (no DOM), see itemRender.ts.

type V3 = [number, number, number];
type M3 = [V3, V3, V3];

const mul = (a: M3, b: M3): M3 =>
  [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j])) as M3;
const apply = (m: M3, v: V3): V3 => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]) as V3;
const rad = (d: number) => (d * Math.PI) / 180;
const rotX = (d: number): M3 => {
  const c = Math.cos(rad(d)), s = Math.sin(rad(d));
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
};
const rotY = (d: number): M3 => {
  const c = Math.cos(rad(d)), s = Math.sin(rad(d));
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
};
const diag = (x: number, y: number, z: number): M3 => [[x, 0, 0], [0, y, 0], [0, 0, z]];
const unit = (v: V3): V3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
function inverse(m: M3): M3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

// RenderHelper.enableGUIStandardItemLighting: the two light directions, rotated into eye space.
const LIGHT_ROTATION = mul(rotY(-30), rotX(165));
const LIGHTS = [unit([0.2, 1, -0.7]), unit([-0.2, 1, 0.7])].map((l) => apply(LIGHT_ROTATION, l));
// RenderItem.renderItemIntoGUI's block transform (translations left out: they don't affect normals).
const BLOCK = mul(mul(mul(mul(diag(10, 10, 10), diag(1, 1, -1)), rotX(210)), rotY(45)), rotY(-90));
/** GL_RESCALE_NORMAL's factor: 1 / |third row of the inverse modelview|. */
const rescale = (k: number) => {
  const r = inverse(mul(diag(k, k, 1), BLOCK))[2];
  return 1 / Math.hypot(r[0], r[1], r[2]);
};

/**
 * How strongly each GUI item light reaches a surface when BetterQuesting draws the item with
 * glScalef(k, k, 1): n'·l' = (rescale(k) / rescale(1)) * (n·l) / |(k lx, k ly, lz)|.
 */
export function lightScale(k: number): [number, number] {
  const r = rescale(k) / rescale(1);
  return LIGHTS.map((l) => r / Math.hypot(k * l[0], k * l[1], l[2])) as [number, number];
}

/** Frame shown at `ms` for frames lasting `ticks` game ticks each, looping from time 0. */
export function frameAt(ticks: number[], ms: number): number {
  const total = ticks.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let t = Math.floor(ms / 50) % total;
  for (let i = 0; i < ticks.length; i++) {
    if (t < ticks[i]) return i;
    t -= ticks[i];
  }
  return 0;
}

