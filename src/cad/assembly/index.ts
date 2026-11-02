/** A board opened on its own level drawn as an assembly of selectable, explodable components (R3-A, 2026-11-02). */
export { BOARD_MIN_COMPONENTS, BOARD_THIN_SHARE, applyBoardPose, boardNormal, countComponents, measureBoard, sideOf, splitBoard, type BoardAssembly, type BoardComponent } from "./board";
export { LIFT_GAP_MIN_MM, LIFT_GAP_SHARE, TIER_BOUNDS_MM, boardMoves, boardSteps, groupOf, liftDistances, liftGap, planBoard, tierOf, windowsFor, withBoard, type BoardGroup, type BoardPartInput, type BoardPlan, type V3 } from "./plan";
export { boardGroups, shortName } from "./groups";
export { componentModel, componentTarget } from "./target";
