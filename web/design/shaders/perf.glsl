/** @resolution */
uniform vec2 u_resolution;

/**
 * @label Cell
 * @default 26
 * @range 8, 80
 */
uniform float u_cell;

/**
 * @label Size
 * @default 5
 * @range 2, 20
 */
uniform float u_size;

/**
 * @label Color
 * @color
 * @default #2E7D52
 */
uniform vec3 u_color;

/**
 * @label Alpha
 * @default 0.6
 * @range 0, 1
 */
uniform float u_alpha;

void main() {
  vec2 p = gl_FragCoord.xy;
  float inX = 1.0 - step(u_size, mod(p.x, u_cell));
  float inY = 1.0 - step(u_size * 0.5, abs(p.y - u_resolution.y * 0.5));
  float s = inX * inY;
  gl_FragColor = vec4(u_color, s * u_alpha);
}
