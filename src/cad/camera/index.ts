/**
 * Camera behaviour (R4-A, 2026-11-02): the Onshape-like zoom with hard stops, the intentional orbit pivot and the
 * pivot dot. Pure rules in ./zoom.ts and ./pivot.ts; the live wiring in ./controller.ts.
 */
export * from "./zoom";
export * from "./pivot";
export { attachCameraPolicy, type CameraHost, type CameraPolicy, type CameraPolicyOptions } from "./controller";
