/** @resolution */
uniform vec2 u_resolution;

/**
 * @label Line Height
 * @default 3
 * @range 2, 8
 */
uniform float u_line;

/**
 * @label Strength
 * @default 0.35
 * @range 0, 1
 */
uniform float u_strength;

/**
 * @label Vignette
 * @default 0.35
 * @range 0, 1
 */
uniform float u_vignette;

void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 uv = p / u_resolution;
  float scan = step(0.5, fract(p.y / u_line));
  float a = scan * 0.16 * u_strength;
  float vig = smoothstep(0.25, 1.05, distance(uv, vec2(0.5, 0.5))) * 0.5 * u_vignette;
  gl_FragColor = vec4(0.0, 0.0, 0.0, clamp(a + vig, 0.0, 0.7));
}
