// Node.js test suite for the horror-game project
// Tests the utility functions and the Game class logic.
// Uses the built‑in `node:test` framework and `assert` for assertions.

'use strict';

const assert = require('assert');
const { test, describe } = require('node:test');

// Import the modules.  They are expected to export the required symbols.
const utils = require('./utils.js');
const { Game } = require('./game.js');

// -----------------------------------------------------------------------------
// Helper: create a minimal mock WebGL context
// -----------------------------------------------------------------------------
function createMockGL() {
  const gl = {
    // Shader and program creation
    createShader: () => ({}),
    createProgram: () => ({}),
    // Attribute and uniform handling
    getAttribLocation: () => 0,
    getUniformLocation: () => 0,
    // State setting
    useProgram: () => {},
    bindBuffer: () => {},
    bufferData: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    // Drawing
    drawArrays: () => {},
    // Constants
    VERTEX_SHADER: 0x8B31,
    FRAGMENT_SHADER: 0x8B30,
    TRIANGLES: 0x0004,
    FLOAT: 0x1406,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88E4,
  };
  return gl;
}

// -----------------------------------------------------------------------------
// Tests for utility functions
// -----------------------------------------------------------------------------
describe('utils', () => {
  test('randomRange returns a value within the specified bounds', () => {
    const min = 5;
    const max = 15;
    for (let i = 0; i < 100; i++) {
      const val = utils.randomRange(min, max);
      assert.ok(val >= min && val <= max, `randomRange(${min}, ${max}) returned ${val}`);
    }
  });

  test('clamp correctly limits values', () => {
    assert.strictEqual(utils.clamp(10, 0, 20), 10, 'value within bounds should stay unchanged');
    assert.strictEqual(utils.clamp(-5, 0, 20), 0, 'value below min should be clamped to min');
    assert.strictEqual(utils.clamp(25, 0, 20), 20, 'value above max should be clamped to max');
  });
});

// -----------------------------------------------------------------------------
// Tests for the Game class
// -----------------------------------------------------------------------------
describe('Game', () => {
  let gl;
  let game;

  beforeEach(() => {
    gl = createMockGL();
    game = new Game(gl);
  });

  test('constructor initializes player health to 100', () => {
    assert.strictEqual(game.player.health, 100, 'initial player health should be 100');
  });

  test('takeDamage reduces player health correctly', () => {
    game.takeDamage(30);
    assert.strictEqual(game.player.health, 70, 'health should be reduced by damage amount');
  });

  test('isGameOver returns false when health is above zero', () => {
    assert.strictEqual(game.isGameOver(), false, 'game should not be over with positive health');
  });

  test('isGameOver returns true when health reaches zero or below', () => {
    game.takeDamage(100);
    assert.strictEqual(game.isGameOver(), true, 'game should be over when health is zero');
    game.takeDamage(10); // further damage
    assert.strictEqual(game.isGameOver(), true, 'game should remain over after additional damage');
  });

  test('start sets the game as running and does not throw', () => {
    assert.doesNotThrow(() => game.start(), 'Game.start() should not throw an error');
    // The Game class may set a flag; we check for a common pattern.
    if ('running' in game) {
      assert.strictEqual(game.running, true, 'Game should set running flag to true on start');
    }
  });

  test('update processes a frame without throwing', () => {
    // Simulate a frame update with a deltaTime of 16ms (~60fps)
    assert.doesNotThrow(() => game.update(16), 'Game.update() should not throw an error');
  });
});
