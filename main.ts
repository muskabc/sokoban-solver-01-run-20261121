// Sokoban solver: room-decomposed, push-optimal breadth-first search.
//
// Idea: a generated level is a hallway with rooms hanging off it, one door
// each, and a box pushed out of its room can never come back. So every box
// stays in its room, each room is an independent little puzzle (3-4 boxes),
// and the level's push optimum is the sum of the rooms' optima. This program
// finds the rooms, solves each one with a breadth-first search over pushes
// (first solved state met is push-optimal), and stitches the rooms' move
// strings together with walks through the hallway.
//
// The search state is the boxes' squares plus the player's reachable region
// (named by its lowest square). A push is pruned when its destination is a
// dead square (no sequence of pushes, other boxes ignored, brings a box
// from there to any goal) or lands the box in a frozen 2x2 block of walls
// and boxes with a box off its goal. Neither prunes a solvable state, so
// the optimum stands. The search is budgeted by states kept, never by the
// clock, and every tie breaks in a fixed order, so two runs write the same
// bytes.
//
// Local run: MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** States kept by one room's search before it gives up. */
const ROOM_STATE_CAP = 300_000;
/** States kept by the whole-level fallback before it gives up. */
const WHOLE_STATE_CAP = 250_000;

interface Dir {
  dx: number;
  dy: number;
  step: string;
  push: string;
}
const DIRS: Dir[] = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

/** Parse XSB text: `#` wall, ` ` floor, `.` goal, `$` box, `*` box on goal, `@` player, `+` player on goal. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]!;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  // Nothing leaves the board: the outer frame is wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares a box alone can be pushed from onto some goal: pull back
 * from the goals over open floor. A box on square y pushed in direction d
 * lands on x = y + d with the player standing on y - d, so from a live x
 * the square y = x - d is live when both y and y - d are open.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const { dx, dy } of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Flood the player's reachable region from `from` around walls and boxes; returns its lowest square. */
function reachLow(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    const up = p - w;
    const down = p + w;
    const left = p - 1;
    const right = p + 1;
    if (wall[up] === 0 && occupied[up] === 0 && seen[up] !== stamp) { seen[up] = stamp; stack[n++] = up; }
    if (wall[down] === 0 && occupied[down] === 0 && seen[down] !== stamp) { seen[down] = stamp; stack[n++] = down; }
    if (wall[left] === 0 && occupied[left] === 0 && seen[left] !== stamp) { seen[left] = stamp; stack[n++] = left; }
    if (wall[right] === 0 && occupied[right] === 0 && seen[right] !== stamp) { seen[right] = stamp; stack[n++] = right; }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four
 * squares of walls and boxes, a box among them off its goal. Such a box
 * can never move again.
 */
function frozenAt(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) {
      return true;
    }
  }
  return false;
}

/**
 * Push-optimal breadth-first search of one level (a room, or a whole level
 * as fallback): { pushes, moves } with moves in LURD (lower a step, upper
 * a push), or null when the search gives up. `keyOf` names a state for the
 * visited table; room searches pack the boxes into one number, the
 * whole-level search joins them into a string.
 */
function pushBfs(
  level: Level,
  cap: number,
  keyOf: (boxes: number[], low: number) => number | string,
): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const stateBoxes: number[][] = [level.boxes];
  const statePlayer: number[] = [level.player];
  const parent: number[] = [-1];
  // The push that made each state: the box's square before and after.
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const visited = new Map<number | string, number>();

  for (const b of level.boxes) occupied[b] = 1;
  const startLow = reachLow(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  visited.set(keyOf(level.boxes, startLow), 0);

  let found = solved(level.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < stateBoxes.length; head++) {
    const boxes = stateBoxes[head]!;
    const player = statePlayer[head]!;
    for (const b of boxes) occupied[b] = 1;
    reachLow(level, occupied, player, seen, ++stamp, stack);
    const region = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const { dx, dy } of DIRS) {
        const d = dy * w + dx;
        const behind = b - d;
        const t = b + d;
        // The player must reach the square behind the box, and the box
        // must land on open, unoccupied, live floor.
        if (seen[behind] !== region) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenAt(level, occupied, goal, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, z) => a - z);
          key = keyOf(next, reachLow(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || visited.has(key)) continue;
        if (stateBoxes.length >= cap) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        visited.set(key, stateBoxes.length);
        stateBoxes.push(next!);
        statePlayer.push(b);
        parent.push(head);
        pushFrom.push(b);
        pushTo.push(t);
        if (solved(next!)) {
          found = stateBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The chain of pushes, then the moves: walk to each push's square, push.
  const chain: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of chain) {
    const from = pushFrom[s]!;
    const to = pushTo[s]!;
    const d = to - from;
    const dir = DIRS.find(({ dx, dy }) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir.push;
    player = from;
    boxes = stateBoxes[s]!;
  }
  return { pushes: chain.length, moves };
}

/** Shortest walk from `from` to `to` around walls and boxes, lower LURD letters; ties go u, d, l, r. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const { dx, dy, step } of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The player's square after playing `moves` (case aside) from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the
 * hallway: a box there reaches no goal) out of the floor, and each part
 * left that holds a box is a room. Null when a box starts in the hallway,
 * a goal is cut off, or some part's boxes and goals do not match: then the
 * level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  const roomOfPart: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const { dx, dy } of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    const room: Room = { boxes: [], goals: [], done: false };
    rooms.push(room);
    roomOfPart.push(room);
  }
  for (const b of boxes) roomOfPart[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    roomOfPart[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Solve a level room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their
 * room is done), the player walking on from where the last room left it.
 * Falls back to one search over the whole level when the level is no set
 * of rooms. Null when a search gives up.
 */
function solveLevel(level: Level): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  if (process.env.MAKEFUN_DEBUG) {
    console.error(`solveLevel: rooms=${rooms === null ? 'null' : rooms.map((r) => `${r.boxes.length}b/${r.goals.length}g`).join(',')}`);
  }
  if (rooms === null) {
    return pushBfs(level, WHOLE_STATE_CAP, (boxes, low) => `${low}|${boxes.join(',')}`);
  }
  const size = level.wall.length;
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice(),
      boxes: room.boxes.slice(),
      player,
    };
    // One number names a room state: the region's lowest square and the
    // boxes, digits in base `size` (exact while size ** 5 stays under 2 ** 53).
    const solved = pushBfs(sub, ROOM_STATE_CAP, (boxes, low) => {
      let k = low;
      for (const b of boxes) k = k * size + b;
      return k;
    });
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

function solve(text: string): string {
  try {
    const found = solveLevel(parseLevel(text));
    if (process.env.MAKEFUN_DEBUG) {
      console.error(`solve: ${found === null ? 'null' : `${found.pushes} pushes, ${found.moves.length} moves`}`);
    }
    return found === null ? '' : found.moves;
  } catch (e) {
    if (process.env.MAKEFUN_DEBUG) console.error('solve: threw', e);
    // One bad level must never sink the whole set.
    return '';
  }
}

for (const id of readdirSync(INPUT).sort()) {
  const moves = solve(readFileSync(join(INPUT, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}
