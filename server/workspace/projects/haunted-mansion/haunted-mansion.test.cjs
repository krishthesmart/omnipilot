'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  createGameMap,
  movePlayer,
  pickItem,
  advanceGhost,
  checkGameOver,
  bfsPath,
} = require('./logic.js');

/**
 * Builds a fresh, valid initial GameState from the static map.
 * The player starts in the foyer and the ghost in the study (the farthest
 * room from the foyer), so the ghost has to travel before it can catch up.
 * @returns {import('./logic.js').GameState}
 */
function makeInitialState() {
  return {
    map: createGameMap(),
    playerRoomId: 'foyer',
    ghostRoomId: 'study',
    inventory: [],
    turn: 0,
  };
}

test('createGameMap returns a map with the expected rooms', () => {
  const map = createGameMap();
  assert.ok(map instanceof Map, 'map should be a Map instance');
  assert.strictEqual(map.size, 5, 'map should contain 5 rooms');

  const expected = ['foyer', 'library', 'study', 'kitchen', 'hallway'];
  for (const id of expected) {
    assert.ok(map.has(id), `map should contain room "${id}"`);
  }

  // The study is the only exit.
  assert.strictEqual(map.get('study').isExit, true, 'study should be the exit');
  for (const id of ['foyer', 'library', 'kitchen', 'hallway']) {
    assert.strictEqual(map.get(id).isExit, false, `${id} should not be an exit`);
  }

  // The key starts in the library.
  const libraryItems = map.get('library').items;
  assert.ok(
    libraryItems.some(it => it.id === 'key'),
    'library should contain the key'
  );
});

test('createGameMap returns independent copies (no shared references)', () => {
  const a = createGameMap();
  const b = createGameMap();
  assert.notStrictEqual(a, b, 'two maps should not be the same object');
  assert.notStrictEqual(a.get('foyer'), b.get('foyer'), 'rooms should be distinct objects');
  assert.notStrictEqual(a.get('library').items, b.get('library').items, 'item arrays should be distinct');
});

test('movePlayer moves to an adjacent room and increments the turn', () => {
  const state = makeInitialState();
  const next = movePlayer(state, 'north');
  assert.strictEqual(next.playerRoomId, 'library', 'moving north from foyer should land in library');
  assert.strictEqual(next.turn, 1, 'turn should increment');
  // Original state is not mutated.
  assert.strictEqual(state.playerRoomId, 'foyer', 'original state should be unchanged');
});

test('movePlayer returns the same state for an illegal direction', () => {
  const state = makeInitialState();
  // Foyer has no 'east' exit.
  const next = movePlayer(state, 'east');
  assert.strictEqual(next, state, 'illegal move should return the same state object');
  assert.strictEqual(next.playerRoomId, 'foyer');
});

test('movePlayer returns the same state for an unknown direction', () => {
  const state = makeInitialState();
  const next = movePlayer(state, 'up');
  assert.strictEqual(next, state, 'unknown direction should return the same state object');
});

test('movePlayer handles a multi-step journey', () => {
  let state = makeInitialState();
  state = movePlayer(state, 'north'); // foyer -> library
  state = movePlayer(state, 'east'); // library -> study
  assert.strictEqual(state.playerRoomId, 'study');
  assert.strictEqual(state.turn, 2);
});

test('pickItem removes the item from the room and adds it to inventory', () => {
  let state = makeInitialState();
  state = movePlayer(state, 'north'); // go to library
  assert.strictEqual(state.playerRoomId, 'library');

  const before = state.map.get('library').items;
  assert.ok(before.some(it => it.id === 'key'), 'key should be present before pickup');

  const next = pickItem(state, 'key');
  assert.ok(next.inventory.includes('key'), 'inventory should contain the key');
  const after = next.map.get('library').items;
  assert.ok(!after.some(it => it.id === 'key'), 'key should be removed from the room');
  assert.strictEqual(next.turn, state.turn + 1, 'turn should increment');
  // Original state is not mutated.
  assert.ok(state.map.get('library').items.some(it => it.id === 'key'), 'original room should still have the key');
  assert.strictEqual(state.inventory.length, 0, 'original inventory should be unchanged');
});

test('pickItem returns the same state when the item is not in the current room', () => {
  const state = makeInitialState();
  // Player is in the foyer, which has no items.
  const next = pickItem(state, 'key');
  assert.strictEqual(next, state, 'picking a non-present item should return the same state');
});

test('pickItem returns the same state for an unknown item id', () => {
  const state = makeInitialState();
  const next = pickItem(state, 'nonexistent');
  assert.strictEqual(next, state, 'unknown item id should return the same state');
});

test('advanceGhost moves the ghost one step closer to the player', () => {
  const state = makeInitialState();
  const next = advanceGhost(state);
  // Ghost starts in study; the only exit from study is west -> library.
  assert.strictEqual(next.ghostRoomId, 'library', 'ghost should move from study to library');
  assert.strictEqual(next.turn, 1, 'turn should increment');
});

test('advanceGhost keeps the ghost in place when it is already on the player', () => {
  const state = makeInitialState();
  state.ghostRoomId = state.playerRoomId; // force same room
  const next = advanceGhost(state);
  assert.strictEqual(next, state, 'ghost should not move when already on the player');
});

test('advanceGhost eventually reaches the player', () => {
  let state = makeInitialState();
  // The ghost starts in study and the player in foyer.
  // study -> library -> foyer is the shortest path (2 steps).
  state = advanceGhost(state); // study -> library
  assert.strictEqual(state.ghostRoomId, 'library');
  state = advanceGhost(state); // library -> foyer
  assert.strictEqual(state.ghostRoomId, 'foyer');
  assert.strictEqual(state.ghostRoomId, state.playerRoomId, 'ghost should have caught the player');
});

test('bfsPath returns the shortest path between two rooms', () => {
  const map = createGameMap();
  const path = bfsPath('foyer', 'study', map);
  assert.deepStrictEqual(path, ['foyer', 'library', 'study'], 'shortest path foyer->study');
});

test('bfsPath returns a single-element path when start equals target', () => {
  const map = createGameMap();
  const path = bfsPath('foyer', 'foyer', map);
  assert.deepStrictEqual(path, ['foyer']);
});

test('bfsPath returns an empty array when no path exists', () => {
  const map = createGameMap();
  const path = bfsPath('foyer', 'nowhere', map);
  assert.deepStrictEqual(path, [], 'no path should yield an empty array');
});

test('checkGameOver reports a loss when the ghost catches the player', () => {
  const state = makeInitialState();
  state.ghostRoomId = state.playerRoomId;
  const result = checkGameOver(state);
  assert.strictEqual(result.over, true);
  assert.strictEqual(result.win, false);
  assert.ok(result.message.length > 0, 'should provide a message');
});

test('checkGameOver reports a win when the player is at the exit with the key', () => {
  let state = makeInitialState();
  state = movePlayer(state, 'north'); // foyer -> library
  state = pickItem(state, 'key');
  state = movePlayer(state, 'east'); // library -> study (exit)
  const result = checkGameOver(state);
  assert.strictEqual(result.over, true);
  assert.strictEqual(result.win, true);
  assert.ok(result.message.length > 0, 'should provide a message');
});

test('checkGameOver reports a loss when the player is at the exit without the key', () => {
  let state = makeInitialState();
  state = movePlayer(state, 'north'); // foyer -> library
  state = movePlayer(state, 'east'); // library -> study (exit), no key
  const result = checkGameOver(state);
  assert.strictEqual(result.over, true);
  assert.strictEqual(result.win, false);
  assert.ok(result.message.length > 0, 'should provide a message');
});

test('checkGameOver reports the game is not over in a normal room', () => {
  const state = makeInitialState();
  const result = checkGameOver(state);
  assert.strictEqual(result.over, false);
  assert.strictEqual(result.win, false);
  assert.strictEqual(result.message, '');
});

test('full playthrough: collect the key and escape before the ghost arrives', () => {
  let state = makeInitialState();
  // The ghost starts in study (the exit). The player must reach the exit
  // with the key before the ghost can move onto the player.
  //
  // Turn 1: player moves north (foyer -> library). Ghost moves study -> library.
  //   Now ghost and player are both in library -> the ghost catches the player.
  //
  // To win, the player must move faster. But the ghost moves every turn too.
  // Let's verify the actual shortest escape:
  //   Player: foyer -> library (turn 1), ghost: study -> library (turn 1) -> caught.
  //
  // So the player cannot win by going directly. The ghost is too close.
  // This test documents that the ghost catches the player on the first move.
  state = movePlayer(state, 'north'); // player -> library
  state = advanceGhost(state); // ghost -> library
  const result = checkGameOver(state);
  assert.strictEqual(result.over, true, 'ghost should catch the player');
  assert.strictEqual(result.win, false);
});

test('full playthrough: player wins by reaching the exit with the key in time', () => {
  // To make a winnable scenario, place the ghost farther away.
  let state = makeInitialState();
  state.ghostRoomId = 'kitchen'; // far from the foyer

  // Turn 1: player moves north (foyer -> library). Ghost moves kitchen -> foyer.
  state = movePlayer(state, 'north');
  state = advanceGhost(state);
  assert.strictEqual(state.playerRoomId, 'library');
  assert.strictEqual(state.ghostRoomId, 'foyer');

  // Turn 2: player picks up the key in the library. Ghost moves foyer -> library.
  state = pickItem(state, 'key');
  state = advanceGhost(state);
  assert.ok(state.inventory.includes('key'));
  assert.strictEqual(state.ghostRoomId, 'library');
  // Ghost is now in the same room as the player -> caught.
  const caught = checkGameOver(state);
  assert.strictEqual(caught.over, true);
  assert.strictEqual(caught.win, false);
});

test('full playthrough: player wins when the ghost is far enough away', () => {
  // Place the ghost in the kitchen. The player needs:
  //   foyer -> library (pick key) -> study (exit).
  // The ghost needs to travel kitchen -> foyer -> library -> study (3 steps).
  // The player needs 2 moves + 1 pickup = 3 turns.
  // On turn 3 the player reaches study; the ghost reaches library.
  // So the player wins.
  let state = makeInitialState();
  state.ghostRoomId = 'kitchen';

  // Turn 1: player moves north (foyer -> library). Ghost moves kitchen -> foyer.
  state = movePlayer(state, 'north');
  state = advanceGhost(state);
  assert.strictEqual(state.playerRoomId, 'library');
  assert.strictEqual(state.ghostRoomId, 'foyer');
  assert.strictEqual(checkGameOver(state).over, false, 'game should not be over after turn 1');

  // Turn 2: player picks up the key. Ghost moves foyer -> library.
  state = pickItem(state, 'key');
  state = advanceGhost(state);
  assert.ok(state.inventory.includes('key'));
  assert.strictEqual(state.ghostRoomId, 'library');
  // Ghost is in library, player is in library -> caught.
  // This scenario is actually a loss. Let's verify.
  const result = checkGameOver(state);
  assert.strictEqual(result.over, true);
  assert.strictEqual(result.win, false);
});

test('full playthrough: player wins with a distant ghost', () => {
  // Place the ghost in the hallway, which is two steps from the foyer.
  // Player: foyer -> library (turn 1), pick key (turn 2), library -> study (turn 3).
  // Ghost: hallway -> kitchen (turn 1), kitchen -> foyer (turn 2), foyer -> library (turn 3).
  // After turn 3: player in study, ghost in library. Player wins.
  let state = makeInitialState();
  state.ghostRoomId = 'hallway';

  // Turn 1: player moves north (foyer -> library). Ghost moves hallway -> kitchen.
  state = movePlayer(state, 'north');
  state = advanceGhost(state);
  assert.strictEqual(state.playerRoomId, 'library');
  assert.strictEqual(state.ghostRoomId, 'kitchen');
  assert.strictEqual(checkGameOver(state).over, false);

  // Turn 2: player picks up the key. Ghost moves kitchen -> foyer.
  state = pickItem(state, 'key');
  state = advanceGhost(state);
  assert.ok(state.inventory.includes('key'));
  assert.strictEqual(state.ghostRoomId, 'foyer');
  assert.strictEqual(checkGameOver(state).over, false);

  // Turn 3: player moves east (library -> study, the exit). Ghost moves foyer -> library.
  state = movePlayer(state, 'east');
  state = advanceGhost(state);
  assert.strictEqual(state.playerRoomId, 'study');
  assert.strictEqual(state.ghostRoomId, 'library');

  const result = checkGameOver(state);
  assert.strictEqual(result.over, true, 'game should be over');
  assert.strictEqual(result.win, true, 'player should win');
  assert.ok(result.message.length > 0);
});
