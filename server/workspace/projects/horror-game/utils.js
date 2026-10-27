/**
 * Utility functions for the horror game.
 * Provides shader compilation, program linking, random number generation, and clamping.
 * Works both in browser (global) and Node (CommonJS).
 */
(function (global, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    global.utils = factory();
  }
})(typeof window !== "undefined" ? window : this, function () {
  /**
   * Compile a WebGL shader.
   * @param {WebGLRenderingContext} gl - WebGL context.
   * @param {GLenum} type - Shader type (gl.VERTEX_SHADER or gl.FRAGMENT_SHADER).
   * @param {string} source - GLSL source code.
   * @returns {WebGLShader} Compiled shader.
   * @throws {Error} If compilation fails or gl is missing.
   */
  function createShader(gl, type, source) {
    if (!gl) throw new Error("WebGL context is required");
    const shader = gl.createShader(type);
    if (!shader) throw new Error("Unable to create shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error("Could not compile shader:\n" + info);
    }
    return shader;
  }

  /**
   * Link a vertex and fragment shader into a program.
   * @param {WebGLRenderingContext} gl - WebGL context.
   * @param {string} vsSource - Vertex shader source.
   * @param {string} fsSource - Fragment shader source.
   * @returns {WebGLProgram} Linked program.
   * @throws {Error} If linking fails or gl is missing.
   */
  function createProgram(gl, vsSource, fsSource) {
    if (!gl) throw new Error("WebGL context is required");
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vsSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      throw new Error("Unable to create program");
    }
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      throw new Error("Could not link program:\n" + info);
    }
    // Clean up shaders after linking
    gl.detachShader(program, vertexShader);
    gl.detachShader(program, fragmentShader);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return program;
  }

  /**
   * Generate a random number in the inclusive range [min, max).
   * @param {number} min - Minimum value.
   * @param {number} max - Maximum value.
   * @returns {number} Random number.
   * @throws {TypeError} If arguments are not numbers.
   */
  function randomRange(min, max) {
    if (typeof min !== "number" || typeof max !== "number") {
      throw new TypeError("min and max must be numbers");
    }
    if (min > max) [min, max] = [max, min];
    return Math.random() * (max - min) + min;
  }

  /**
   * Clamp a value between min and max.
   * @param {number} val - Value to clamp.
   * @param {number} min - Minimum bound.
   * @param {number} max - Maximum bound.
   * @returns {number} Clamped value.
   * @throws {TypeError} If arguments are not numbers.
   */
  function clamp(val, min, max) {
    if (typeof val !== "number" || typeof min !== "number" || typeof max !== "number") {
      throw new TypeError("val, min, and max must be numbers");
    }
    if (min > max) [min, max] = [max, min];
    return Math.min(Math.max(val, min), max);
  }

  return {
    createShader,
    createProgram,
    randomRange,
    clamp,
  };
});
