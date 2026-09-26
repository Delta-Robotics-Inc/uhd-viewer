import type { LevelLayout } from "./layout";

/**
 * Hand layout for the quadcopter's top level: arms at the four corners,
 * GNSS / stack / video down the centre, battery and receiver either side,
 * and the frame along the bottom collecting every mechanical mount.
 */
const ARM = { w: 270, h: 132 };

export const QUADCOPTER_TOP: LevelLayout = {
  nodes: {
    arm_fl: { x: 40, y: 40, ...ARM },
    "arm_fl/prop": { x: 34, y: 50 },
    "arm_fl/motor": { x: 158, y: 36 },
    arm_fr: { x: 1090, y: 40, ...ARM },
    "arm_fr/motor": { x: 34, y: 36 },
    "arm_fr/prop": { x: 176, y: 50 },
    arm_rl: { x: 40, y: 640, ...ARM },
    "arm_rl/prop": { x: 34, y: 50 },
    "arm_rl/motor": { x: 158, y: 36 },
    arm_rr: { x: 1090, y: 640, ...ARM },
    "arm_rr/motor": { x: 34, y: 36 },
    "arm_rr/prop": { x: 176, y: 50 },

    gnss: { x: 575, y: 40, w: 250, h: 100 },
    stack: { x: 580, y: 320, w: 240, h: 290 },
    battery: { x: 340, y: 466, w: 210, h: 110 },
    receiver: { x: 960, y: 450, w: 200, h: 100 },
    video: { x: 700, y: 700, w: 240, h: 120 },
    frame: { x: 40, y: 900, w: 1320, h: 86 },
  },
  ports: {
    "arm_fl|motor__base_mount": "bottom",
    "arm_fr|motor__base_mount": "bottom",
    "frame|motor_mount_fl": "left",
    "frame|motor_mount_fr": "right",
    "frame|motor_mount_rl": "top",
    "frame|motor_mount_rr": "top",
    "frame|stack_mount": "top",
    "frame|camera_mount": "top",
    "frame|vtx_mount": "top",
    "stack|stack_mount": "bottom",
    "video|camera_mount": "bottom",
    "video|tx_module_mount": "bottom",
  },
  links: {
    arm_fl_mount: { waypoints: [[18, 196], [18, 943]] },
    arm_fr_mount: { waypoints: [[1382, 196], [1382, 943]] },
  },
};
