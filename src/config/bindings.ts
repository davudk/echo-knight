/**
 * All input bindings in one place. Gameplay code only ever talks about *actions*,
 * never raw keys or buttons, so rebinding / a settings menu later is a data change.
 *
 * Gamepad indices follow the W3C "standard" mapping (Xbox naming):
 *   0 A/Cross  1 B/Circle  2 X/Square  3 Y/Triangle  4 LB/L1  5 RB/R1  6 LT/L2  7 RT/R2
 *   8 Back  9 Start  10 L3  11 R3  12 Up  13 Down  14 Left  15 Right
 */
export type Action = 'jump' | 'dodge' | 'attack' | 'echo' | 'sprint' | 'recenter' | 'pause';

export interface ActionBinding {
  keys: string[]; // KeyboardEvent.code
  mouse: number[]; // MouseEvent.button
  pad: number[]; // standard gamepad button index
}

export const Bindings: Record<Action, ActionBinding> = {
  jump: { keys: ['Space'], mouse: [], pad: [0] },
  dodge: { keys: ['ShiftLeft', 'ShiftRight', 'KeyK'], mouse: [], pad: [1] },
  attack: { keys: ['KeyJ'], mouse: [0], pad: [2, 5] },
  echo: { keys: ['KeyE', 'KeyL'], mouse: [2], pad: [3, 4] },
  sprint: { keys: ['ControlLeft', 'AltLeft'], mouse: [], pad: [10, 6] },
  recenter: { keys: ['KeyQ'], mouse: [1], pad: [11] },
  pause: { keys: ['Escape'], mouse: [], pad: [9] },
};

export const MoveKeys = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
};

export const PadAxes = { moveX: 0, moveY: 1, lookX: 2, lookY: 3 };

/** Labels used by the HUD for control prompts. */
export const PromptLabels: Record<'kbm' | 'pad', Record<string, string>> = {
  kbm: {
    move: 'WASD',
    look: 'Mouse',
    jump: 'Space',
    dodge: 'Shift',
    attack: 'LMB / J',
    echo: 'E / RMB',
    sprint: 'Ctrl',
    recenter: 'Q / MMB',
  },
  pad: {
    move: 'L-Stick',
    look: 'R-Stick',
    jump: 'A',
    dodge: 'B',
    attack: 'X / RB',
    echo: 'Y / LB',
    sprint: 'L3 / LT',
    recenter: 'R3',
  },
};
