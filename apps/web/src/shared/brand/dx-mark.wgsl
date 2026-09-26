struct Params {
  time: f32,
  state: f32,
  pointer: vec2f,
}

@group(0) @binding(0) var glyphTexture: texture_2d<f32>;
@group(0) @binding(1) var glyphSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

fn glyph(uv: vec2f) -> f32 {
  let inside = select(0.0, 1.0, uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0);
  return textureSampleLevel(glyphTexture, glyphSampler, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).a * inside;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let idle = params.state < 0.5;
  let thinking = params.state > 0.5 && params.state < 1.5;
  let working = params.state > 1.5 && params.state < 2.5;
  let complete = params.state > 2.5 && params.state < 3.5;
  let failed = params.state > 3.5 && params.state < 4.5;
  let loading = params.state > 4.5;

  var shift = 0.0;
  if (idle || thinking || working || complete) {
    let pointerDistance = abs(uv.y - params.pointer.y);
    let pointerEnvelope = exp(-pointerDistance * pointerDistance * 90.0);
    let pointerWave = (params.pointer.x - 0.5) * pointerEnvelope * 0.002;
    if (idle) {
      shift = sin(uv.y * 11.0 + params.time * 0.58) * 0.0017 + pointerWave;
    }
    if (thinking) {
      let breath = 0.35 + 0.65 * (sin(params.time * 0.82) * 0.5 + 0.5);
      shift = sin((uv.y - 0.5) * 15.0) * breath * 0.0034 + pointerWave;
    }
    if (working) {
      let travel = sin(uv.y * 14.0 - params.time * 1.65) * 0.0037;
      let detail = sin(uv.y * 27.0 - params.time * 2.25) * 0.0008;
      shift = travel + detail + pointerWave;
    }
    if (complete) {
      shift = sin(uv.y * 10.0 + params.time * 0.38) * 0.0011 + pointerWave * 0.5;
    }
  }

  let base = glyph(uv - vec2f(shift, 0.0));
  var alpha = base;
  var color = vec3f(0.965, 1.0, 0.96);
  if (thinking) { color = vec3f(0.72, 0.61, 1.0); }
  if (working) { color = vec3f(0.965, 0.514, 0.231); }
  if (complete) { color = vec3f(0.39, 0.86, 0.55); }
  if (failed) { color = vec3f(1.0, 0.28, 0.22); }

  var waterHighlight = 0.0;
  if (loading) {
    let linearProgress = clamp(params.time * 0.27, 0.0, 1.0);
    let progress = 1.0 - pow(1.0 - linearProgress, 1.35);
    let level = 0.58 - progress * 0.38;
    let sideToSide = (uv.x - 0.5) * sin(progress * 9.42478) * 0.025;
    let smallRipple = sin(uv.x * 17.0 + progress * 8.0) * (1.0 - progress) * 0.006;
    let waterSurface = level + sideToSide + smallRipple;
    let waterMask = smoothstep(waterSurface - 0.008, waterSurface + 0.008, uv.y);
    alpha = base * waterMask;
    waterHighlight = base * exp(-abs(uv.y - waterSurface) * 135.0) * 0.7;
    color = vec3f(0.72, 0.96, 0.84);
  }

  let finalColor = color * alpha + vec3f(0.86, 1.0, 0.94) * waterHighlight;
  return vec4f(finalColor, max(alpha, waterHighlight));
}
