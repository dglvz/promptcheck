import { Command } from "commander";
import { VERSION } from "../version.js";

/** Construye el programa de la CLI. Separado de index.ts para poder probarlo sin ejecutar. */
export function createProgram(): Command {
  return new Command()
    .name("promptcheck")
    .description("Evalúa prompts de Claude como si fueran pruebas unitarias.")
    .version(VERSION, "-v, --version", "muestra la versión")
    .helpOption("-h, --help", "muestra la ayuda");
}
