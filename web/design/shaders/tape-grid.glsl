/** @resolution */
uniform vec2 u_resolution;

/**
 * @label Base
 * @color
 * @default #0D1110
 */
uniform vec3 u_base;

/**
 * @label Grid
 * @color
 * @default #1C3326
 */
uniform vec3 u_grid;

/**
 * @label Cell
 * @default 32
 * @range 8, 128
 */
uniform float u_cell;

/**
 * @label Grid Strength
 * @default 0.75
 * @range 0, 1
 */
uniform float u_gridStrength;

/**
 * @label Scan Strength
 * @default 0.5
 * @range 0, 1
 */
uniform float u_scan;

void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 cell = abs(fract(p / u_cell) - 0.5);
  float line = 1.0 - step(0.04, max(cell.x, cell.y));
  vec3 col = mix(u_base, u_grid, line * u_gridStrength);
  float scan = step(0.5, fract(p.y * 0.5));
  col *= 1.0 - scan * 0.07 * u_scan;
  gl_FragColor = vec4(col, 1.0);
}
