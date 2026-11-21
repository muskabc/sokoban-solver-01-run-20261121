# Room-wise Push-Optimal Sokoban Solver

Entry for make.fun's "Build the best Sokoban solver, 21 November 2026"
bounty. One program, `main.ts`, answers a whole set of 5 Sokoban levels in
one run (`node /bot/main.ts`, Node 22, no dependencies, no network, no
clock): it reads `/input/<id>/level.txt` and writes
`/output/<id>/solution.txt` for each instance.

## How it works

A generated level is a one-square-wide hallway with rooms hanging off it,
one door each, and a box pushed out of its room can never come back. So
every box stays in its room, each room is an independent little puzzle of
3–4 boxes, and the level's push optimum is the sum of the rooms' optima.
The solver:

1. **Finds the rooms.** It computes the squares a box alone can be pushed
   from onto some goal (pulled back from the goals over open floor), cuts
   the dead squares of the player's row — the hallway, where a box reaches
   no goal — out of the floor, and each remaining part that holds a box is
   a room. If a level is no set of rooms, it falls back to one search over
   the whole level.
2. **Solves each room push-optimally** with a breadth-first search over
   pushes. A state is the boxes' squares plus the player's reachable
   region, named by its lowest square, so walking never branches the
   search. A push is pruned when its destination is a dead square or
   lands the box in a frozen 2×2 block of walls and boxes with a box off
   its goal; neither prunes a solvable state, so the first solved state
   met is push-optimal.
3. **Stitches the rooms together**: the other rooms' boxes stand as walls
   (on their goals once their room is done) while a room is solved, and
   the player walks on from where the last room left it.

The search is budgeted by states kept, never by the wall clock, and every
tie breaks in a fixed order, so two runs write the same bytes. Set
`MAKEFUN_DEBUG=1` for progress notes on stderr.

## Local results

Practice set (the kit's `practice/`): **1,000,000 / 1,000,000** — every
instance solved in exactly its push-optimal count (13, 16, 29, 47, 60
pushes), in about 0.8 s for the whole set. Three further sets drawn fresh
from the kit's generator with new seeds also scored 1,000,000 each, in
about 0.6 s per set. The house baseline (plain-astar 1.0.0) scores
200,000 on the practice set and 287,500 on one of the fresh sets.

Local run:

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Built by an AI agent for make.fun's "Build the best Sokoban solver,
21 November 2026" bounty, $100 in USDC.
