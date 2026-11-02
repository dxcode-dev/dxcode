import {
  ORB_PATH_COUNT,
  ORB_UNREAD_DOT,
  type OrbPose,
  orbPathOpacities,
  traceOrb,
} from "./orb-motion.js";

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Layer = HTMLCanvasElement | OffscreenCanvas;

/**
 * Draws one pose as the SVG renders it: sixteen band paths stroked at their
 * own opacity, the breath's scale about the center, group opacity over the
 * composed artwork (through `layer`), and the cut-away around the unread dot.
 * The context's canvas maps the 24-unit viewBox onto its full size.
 */
export const drawOrb = (
  context: Context2D,
  layer: Layer,
  pose: OrbPose,
  color: string,
  unread: boolean,
) => {
  const { width, height } = context.canvas;
  if (layer.width < width || layer.height < height) {
    layer.width = Math.max(layer.width, width);
    layer.height = Math.max(layer.height, height);
  }
  const pen = layer.getContext("2d") as Context2D | null;
  if (!pen) return;
  const paths = Array.from({ length: ORB_PATH_COUNT }, () => new Path2D());
  traceOrb(pose.inner, pose.outer, {
    move: (path, x, y) => paths[path].moveTo(x, y),
    line: (path, x, y) => paths[path].lineTo(x, y),
  });
  const opacities = orbPathOpacities(pose.mix);
  const sx = width / 24;
  const sy = height / 24;
  pen.setTransform(1, 0, 0, 1, 0, 0);
  pen.clearRect(0, 0, width, height);
  // translate(12 12) scale(s) translate(-12 -12), in device pixels.
  pen.setTransform(
    sx * pose.scale,
    0,
    0,
    sy * pose.scale,
    sx * 12 * (1 - pose.scale),
    sy * 12 * (1 - pose.scale),
  );
  pen.lineWidth = 0.7;
  pen.lineCap = "round";
  pen.lineJoin = "round";
  pen.strokeStyle = color;
  for (let i = 0; i < ORB_PATH_COUNT; i++) {
    pen.globalAlpha = opacities[i];
    pen.stroke(paths[i]);
  }
  context.globalCompositeOperation = "copy";
  context.globalAlpha = pose.opacity;
  context.drawImage(layer, 0, 0, width, height, 0, 0, width, height);
  context.globalAlpha = 1;
  if (unread) {
    // The same cut-away the SVG mask makes around the unread dot.
    const r = ORB_UNREAD_DOT.r + ORB_UNREAD_DOT.gap;
    context.globalCompositeOperation = "destination-out";
    context.beginPath();
    context.ellipse(
      ORB_UNREAD_DOT.cx * sx,
      ORB_UNREAD_DOT.cy * sy,
      r * sx,
      r * sy,
      0,
      0,
      Math.PI * 2,
    );
    context.fill();
  }
  context.globalCompositeOperation = "source-over";
};
