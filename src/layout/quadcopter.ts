import type { LevelLayout } from "./layout";

/**
 * Hand layout for the quadcopter's top level: arms at the four corners,
 * GNSS / stack / video down the centre, battery and receiver either side,
 * and the frame along the bottom collecting every mechanical mount. The
 * top plate sits beside the GNSS it carries; fastener harnesses sit on the
 * joints they hold (under each arm, and along the frame).
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
    battery: { x: 230, y: 470, w: 200, h: 110 },
    bulk_cap: { x: 50, y: 316, w: 150, h: 104 },
    strap: { x: 50, y: 520, w: 150, h: 76 },
    xt60_lead: { x: 452, y: 488, w: 104, h: 40 },
    dji_cable: { x: 700, y: 640, w: 150, h: 36 },
    stack_hardware: { x: 470, y: 840, w: 150, h: 36 },
    top_plate: { x: 880, y: 196, w: 170, h: 84 },
    gps_hardware: { x: 880, y: 70, w: 150, h: 36 },
    frame_hardware: { x: 1010, y: 840, w: 150, h: 36 },
    vtx_hardware: { x: 830, y: 840, w: 150, h: 36 },
    camera_hardware: { x: 650, y: 840, w: 150, h: 36 },
    arm_fl_hardware: { x: 90, y: 200, w: 150, h: 36 },
    arm_fr_hardware: { x: 1160, y: 200, w: 150, h: 36 },
    arm_rl_hardware: { x: 90, y: 800, w: 150, h: 36 },
    arm_rr_hardware: { x: 1160, y: 800, w: 150, h: 36 },
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
    "gnss|mount": "right",
    "bulk_cap|pos": "right",
    "bulk_cap|neg": "right",
    "frame|standoff_mount": "top",
    "top_plate|standoff_mount": "bottom",
    "top_plate|gps_mount": "left",
  },
  links: {
    arm_fl_mount: { waypoints: [[18, 196], [18, 943]] },
    arm_fr_mount: { waypoints: [[1382, 196], [1382, 943]] },
    bulk_cap_pos: { waypoints: [[452, 368]] },

  },
};
