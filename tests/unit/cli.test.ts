import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli/program.js";
import { VERSION } from "../../src/index.js";

describe("cli", () => {
  it("expone el nombre y la versión del paquete", () => {
    const program = createProgram();
    expect(program.name()).toBe("promptcheck");
    expect(program.version()).toBe(VERSION);
  });

  it("la versión es SemVer", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
